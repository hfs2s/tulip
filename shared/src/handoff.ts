/**
 * The handoff contract — the complete interface between the trusted bridge and
 * the untrusted agent.
 *
 * There is no RPC, no socket and no shared network between the two halves of
 * Tulip. They communicate only by writing JSON files into two Docker volumes
 * with opposite permissions, and *this file is the whole vocabulary*. If a
 * concept is not expressible here, the agent cannot ask for it.
 *
 * Two rules govern every schema below. Both exist because the agent is assumed
 * to be executing an attacker's code:
 *
 *   1. **The agent addresses chats the bridge issued keys for, or nothing.**
 *      Outbound actions default to `turnId`, which the bridge resolves through
 *      a map the agent cannot write. `sendTo` and the four media verbs may name
 *      a `chatKey` instead — but only a key the bridge minted, only with
 *      `agent.crossChat` on, and never a phone number or a jid. The address
 *      space is issued, not chosen. See THREAT-MODEL.md §T4.
 *
 *   2. **The agent never learns a phone number.** Chats are identified by an
 *      opaque `chatKey` derived from a salt the agent cannot read. Personal
 *      identifiers stay in the bridge, so a successful exfiltration yields
 *      display names at worst.
 *
 *      `contact` runs the other way and is worth reading as the exception that
 *      proves the rule: it takes a number the *operator* typed and returns a
 *      key. Nothing flows outward, and it is refused on any turn that is not an
 *      operator's.
 *
 * Schemas are `.strict()` throughout: an unknown field is a parse error, not a
 * silently ignored one. A tolerant parser is how an attacker smuggles a field
 * that some later version learns to honour.
 */
import { z } from 'zod';

// ─── Primitives ──────────────────────────────────────────────────────────────

/**
 * An opaque, stable, non-reversible handle for one chat. Derived by the bridge
 * from the chat's WhatsApp id and a per-deployment salt; see `ids.ts`.
 *
 * Fixed-length hex so it is safe to interpolate into a filesystem path without
 * further sanitising — which the agent's session pool does when it names tmux
 * windows and workspace directories.
 */
export const ChatKey = z.string().regex(/^[0-9a-f]{16}$/, 'chatKey must be 16 lowercase hex characters');

/**
 * An optional destination for an outbound action, for the media verbs.
 *
 * `null` — the default, and the shape every action had before this existed —
 * means "the chat whose turn this is", resolved from `turnId` through a map the
 * agent cannot write. A key means the same thing `sendTo` means: a chat the
 * bridge itself issued a key for, gated on `agent.crossChat`, refused if the
 * chat is blocked or unknown.
 *
 * Nullable-with-a-default rather than a new `voiceTo`/`imageTo` kind, for two
 * reasons. Actions already written to the outbox still parse, so a deploy
 * cannot strand a queued action mid-flight; and the vocabulary for naming a
 * destination stays in one place, which is the thing a reviewer needs to be
 * able to find. `mentionsMe` above was added the same way.
 *
 * This widens the *medium*, not the address space. Text could already reach any
 * of these chats through `sendTo`; audio, pictures and files could not, for no
 * reason anybody defended. There is still no way to name a phone number here.
 */
const Destination = ChatKey.nullable().default(null);

/** Identifies one delivery of one batch. Opaque to the agent; a UUID in practice. */
export const TurnId = z.string().uuid();

/**
 * A file the agent has placed in `out/files/` for sending.
 *
 * A bare basename, deliberately. Not a path: no separators, no traversal, no
 * leading dot, and the bridge additionally resolves and re-checks the result
 * against its own directory before opening it. Validating here is convenience;
 * the check at the boundary is the control.
 */
export const OutFileName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must be a plain file name')
  .refine((s) => !s.includes('..'), 'must not contain ".."');

/**
 * A path to a received attachment, relative to the read-only inbound mount.
 * The agent reads these directly; it never receives an absolute host path.
 */
export const InFilePath = z
  .string()
  .min(1)
  .max(256)
  .regex(/^media\/[0-9a-f]{16}\/[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must be media/<chatKey>/<file>');

// ─── Bridge → agent ──────────────────────────────────────────────────────────

export const MediaKind = z.enum(['image', 'video', 'audio', 'sticker', 'document']);

export const InboundMedia = z
  .object({
    kind: MediaKind,
    /** Relative to the inbound mount, or null when the download failed. */
    path: InFilePath.nullable(),
    mimetype: z.string().max(128).nullable(),
    bytes: z.number().int().nonnegative().nullable(),
    /** Sender-supplied, therefore untrusted display text. Never used as a path. */
    fileName: z.string().max(256).nullable(),
    seconds: z.number().nonnegative().nullable(),
    isVoiceNote: z.boolean(),
    /**
     * What was said, for audio. The agent cannot listen to anything, so without
     * this a voice note is a file it can do nothing with — and somebody who
     * spoke rather than typed gets an answer that ignores them.
     *
     * Null when the attachment is not audio, when transcription is not
     * configured, or when it failed; `error` carries the reason in the last
     * case. Defaulted so a batch written before this existed still parses.
     */
    transcript: z.string().max(4000).nullable().default(null),
    /** Why the attachment is missing, or why it could not be transcribed. */
    error: z.string().max(256).nullable(),
  })
  .strict();

export const InboundMessage = z
  .object({
    /**
     * The sender's WhatsApp display name, or a placeholder. Attacker-controlled:
     * anyone can call themselves "System Administrator". The persona is told to
     * treat it as data, and nothing in either half branches on it.
     */
    from: z.string().max(128),
    at: z.string().datetime(),
    text: z.string(),
    /**
     * Whether this message actually @-mentioned us, or replied to one of ours.
     *
     * Derived by the bridge from WhatsApp's own mention metadata, so unlike
     * `from` and `text` it is not attacker-controlled — a sender cannot fake
     * being a mention by typing one.
     *
     * It exists because of judgement mode. In `mention` and `trigger` modes the
     * gate decides and the agent never needed to know; in `observe` the agent
     * is the one deciding whether to speak, and it was deciding blind on the
     * single most important signal — "was this addressed to me". A question
     * that names somebody else looks exactly like a question aimed at you when
     * all you have is the text.
     *
     * Defaulted rather than required, for the batch that is already on disk when
     * the bridge is upgraded under it. A required field would reject that batch
     * outright and lose the turn — and `false` is the conservative reading: a
     * message we cannot prove was addressed to us was not.
     */
    mentionsMe: z.boolean().default(false),
    quoted: z
      .object({ text: z.string().max(2000), isMine: z.boolean() })
      .strict()
      .nullable(),
    media: z.array(InboundMedia).max(8),
  })
  .strict();

/**
 * One batch of messages handed to the agent. Written to `in/batches/<turnId>.json`
 * by the bridge, which is the only writer — the agent's mount is read-only, so it
 * cannot forge, edit or replay one.
 */
export const InboxBatch = z
  .object({
    turnId: TurnId,
    chatKey: ChatKey,
    /** A human label for the chat. Display only, and attacker-controlled. */
    chatName: z.string().max(128),
    isGroup: z.boolean(),
    receivedAt: z.string().datetime(),
    messages: z.array(InboundMessage).min(1).max(50),
  })
  .strict();

/**
 * Which turn the agent is answering right now. Written by the bridge immediately
 * before injection; read by `tulip-wa` so a reply can be stamped with the turn it
 * belongs to.
 */
export const CurrentTurn = z
  .object({
    turnId: TurnId,
    chatKey: ChatKey,
    chatName: z.string().max(128),
    isGroup: z.boolean(),
    /** Path to the batch, relative to the inbound mount. */
    batch: z.string().regex(/^batches\/[0-9a-f-]{36}\.json$/),
    startedAt: z.string().datetime(),
    /**
     * Which capabilities are switched on for this turn.
     *
     * Advisory, and deliberately so: the bridge refuses a switched-off action
     * whatever this says, because it is written into a file the agent reads and
     * a compromised agent could ignore it entirely. It is here to stop the
     * *honest* failure, which is the common one — the agent plans a reply
     * around a GIF, sends the action, and gets nothing back, because a refusal
     * on the bridge side is invisible from inside the container.
     *
     * Each field defaults to `true` so a `current.json` written by an older
     * bridge still parses. That is the safe direction: the agent tries, and the
     * bridge — which reads the real config — refuses.
     */
    can: z
      .object({
        voice: z.boolean().default(true),
        images: z.boolean().default(true),
        gifs: z.boolean().default(true),
        search: z.boolean().default(true),
        crossChat: z.boolean().default(true),
      })
      .strict()
      .default({}),
  })
  .strict();

// ─── Agent → bridge (hostile) ────────────────────────────────────────────────

/**
 * Everything the agent is able to ask for.
 *
 * Note what is absent and cannot be added by an attacker: a file path, a shell
 * command, a URL. The bridge opens files only from its own directory and
 * performs only the actions below. A GIF is a *search phrase*, not a URL, for
 * the same reason.
 *
 * A recipient is the one exception, and it is worth stating precisely because
 * it used to be on that list. Actions default to `turnId`, which the bridge
 * resolves through a map the agent cannot write. `sendTo`, `file`, `gif`,
 * `image` and `voice` may name a chat instead — but only by a key the bridge
 * itself issued, only when an operator has switched `agent.crossChat` on, and
 * none of them can *read* the chat it names. Reach is the same for all five;
 * they differ only in medium. See THREAT-MODEL.md §T4.
 */
export const OutboxAction = z.discriminatedUnion('kind', [
  z
    .object({
      id: z.string().uuid(),
      turnId: TurnId,
      kind: z.literal('text'),
      /**
       * WhatsApp's own limit is far higher, but a public bot has no legitimate
       * reason to emit a wall of text, and a low cap bounds how much a
       * compromised agent can push through the reply channel in one action.
       */
      text: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      turnId: TurnId,
      kind: z.literal('file'),
      /** Where it goes; see `Destination`. Null is this turn's own chat. */
      chatKey: Destination,
      file: OutFileName,
      caption: z.string().max(1024).nullable(),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      turnId: TurnId,
      kind: z.literal('gif'),
      /** Where it goes; see `Destination`. Null is this turn's own chat. */
      chatKey: Destination,
      /**
       * A search phrase, never a URL.
       *
       * The agent has no internet, so it cannot fetch a GIF itself — it names
       * what it wants and the bridge resolves it. That keeps the API key out of
       * the agent container and leaves the egress allowlist untouched. It also
       * means the content rating is enforced somewhere the agent cannot reach:
       * choosing a phrase is expressible here, turning off the filter is not.
       */
      query: z.string().min(1).max(100),
      caption: z.string().max(1024).nullable(),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      turnId: TurnId,
      kind: z.literal('sendTo'),
      /**
       * A chat the bridge has previously issued a key for.
       *
       * This is the one action that names a destination, and it exists only
       * because an operator asked for it. It is refused unless
       * `agent.crossChat` is on, and the key must be one the bridge issued —
       * an invented one resolves to nothing.
       *
       * Note what it still cannot do: read another conversation. Sessions are
       * per chat, so this carries the current conversation outward rather than
       * fetching someone else's inward. See THREAT-MODEL.md §T4.
       */
      chatKey: ChatKey,
      text: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      turnId: TurnId,
      /** List the chats the agent may message. Also gated on `agent.crossChat`. */
      kind: z.literal('chats'),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      turnId: TurnId,
      /**
       * Ask the bridge to issue a chat key for a phone number.
       *
       * This is the one place a number appears in the agent's vocabulary, and
       * it is deliberately the *inverse* of rule 2 rather than an exception to
       * it: the agent does not learn a number here, it hands one back. The
       * number came from the operator, in the operator's own message, which the
       * agent could already read.
       *
       * The control is provenance, and it is checked on the bridge side, not
       * here: this is refused unless the turn it belongs to is an operator's
       * turn. `isOperator()` matches on the sender's jid, which is assigned by
       * WhatsApp and cannot be changed by a sender picking a display name — so
       * a stranger cannot reach this by claiming to be Les. That is the whole
       * reason the capability is safe to have: the number is always chosen by
       * somebody who could have added it in the panel themselves.
       *
       * What it does NOT do: send anything. It mints a key and hands it back.
       * Messaging the result is a separate action, subject to every limit and
       * every switch that governs the rest.
       */
      kind: z.literal('contact'),
      /**
       * E.164-ish, with or without the leading `+`. Digits only otherwise: no
       * jid suffix, no `@s.whatsapp.net`, no group id. The bridge builds the
       * jid itself, so the agent cannot address a domain of its choosing.
       */
      number: z.string().regex(/^\+?[1-9][0-9]{6,17}$/, 'a phone number in international form'),
      /** What to call them in the panel and in the chat list. */
      label: z.string().min(1).max(60),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      turnId: TurnId,
      /**
       * Remember something, for every conversation rather than this one.
       *
       * Deliberate rather than automatic: a transcript is not memory, and an
       * agent that remembers everything remembers the wrong things. The bridge
       * performs the write so it can be capped, logged and shown to an
       * operator — the agent cannot reach the file.
       */
      kind: z.literal('remember'),
      text: z.string().min(1).max(300),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      turnId: TurnId,
      /**
       * Publish a page the agent has already written under `out/pages/<slug>/`.
       *
       * Writing the files is the publishing; this asks the bridge to look at
       * them and hand back the address. Narrow because the slug lands in a URL,
       * and it is the only part of this the agent chooses.
       */
      kind: z.literal('page'),
      slug: z.string().min(3).max(48).regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes'),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      turnId: TurnId,
      /**
       * Write a starting page already wearing the house style.
       *
       * A scaffold rather than an instruction, because the instruction lost: an
       * agent told to link a stylesheet still wrote its own, which is what a
       * strong prior about self-contained HTML does to a line of prose.
       */
      kind: z.literal('pageNew'),
      slug: z.string().min(3).max(48).regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes'),
      title: z.string().min(1).max(120),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      turnId: TurnId,
      /**
       * Generate a picture and write it *into* a page rather than sending it.
       *
       * A separate verb from `image` because the destination is the difference
       * that matters: one goes to a person and one goes to a file, and they
       * spend the same daily allowance.
       */
      kind: z.literal('pageImage'),
      slug: z.string().min(3).max(48).regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes'),
      /** The file it lands as, so the agent can reference it from its HTML. */
      name: z.string().min(1).max(48).regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes'),
      prompt: z.string().min(1).max(1000),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      turnId: TurnId,
      kind: z.literal('image'),
      /** Where it goes; see `Destination`. Null is this turn's own chat. */
      chatKey: Destination,
      /** A description. The bridge generates and sends it; no key reaches the agent. */
      prompt: z.string().min(1).max(1000),
      caption: z.string().max(1024).nullable(),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      turnId: TurnId,
      kind: z.literal('voice'),
      /** Where it goes; see `Destination`. Null is this turn's own chat. */
      chatKey: Destination,
      /** Spoken aloud and sent as a WhatsApp voice note. */
      text: z.string().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      turnId: TurnId,
      kind: z.literal('search'),
      /** A search phrase. Performed by the bridge; see bridge/src/exa.ts. */
      query: z.string().min(1).max(400),
      results: z.number().int().min(1).max(10).default(5),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      turnId: TurnId,
      kind: z.literal('fetch'),
      /**
       * A page to read.
       *
       * Constrained to http(s) here, and the bridge never dials it: it asks the
       * search provider to fetch it and return the text. That distinction is
       * the whole safety argument — a bridge that fetched agent-chosen URLs
       * itself would be a server-side request forgery gadget sitting on both
       * networks. See bridge/src/exa.ts.
       */
      url: z.string().url().max(2000).refine((u) => /^https?:\/\//i.test(u), 'must be http or https'),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      turnId: TurnId,
      kind: z.literal('react'),
      /** A short grapheme cluster. Length-capped rather than emoji-validated. */
      emoji: z.string().min(1).max(16),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      turnId: TurnId,
      kind: z.literal('typing'),
      on: z.boolean(),
    })
    .strict(),
]);

/**
 * The agent's view of itself, for the operator's panel.
 *
 * Advisory only. The bridge never makes a delivery decision from this file —
 * a compromised agent could report anything — it reads it to *display* state and
 * falls back to its own timers for control flow.
 */
export const AgentStatus = z
  .object({
    at: z.string().datetime(),
    /** Set when a turn is running, so the panel and typing indicator can follow. */
    busyTurn: TurnId.nullable(),
    /** Something only a human can clear: expired login, no credit, rate limit. */
    fatal: z.string().max(256).nullable(),
    sessions: z
      .array(
        z
          .object({
            chatKey: ChatKey,
            startedAt: z.string().datetime(),
            lastUsedAt: z.string().datetime(),
            turns: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();

/**
 * The answer to a `search` or `fetch`, written by the bridge into the inbound
 * volume for the agent to read.
 *
 * `content` is text from the open internet. It is the one thing in this system
 * that is hostile *and* not written by the person the agent is talking to, so
 * it is labelled rather than merely delivered: the agent is told what it is
 * holding. See THREAT-MODEL.md §T6 — this channel is what makes indirect
 * prompt injection a live concern rather than a theoretical one.
 */
/** One remembered fact, and where it came from. */
export const MemoryNote = z
  .object({
    id: z.string().uuid(),
    at: z.string().datetime(),
    text: z.string().max(300),
    /** The chat that asked for it, so an operator can see who taught it what. */
    chatKey: ChatKey,
    chatName: z.string().max(128).nullable(),
  })
  .strict();

export const MemoryFile = z.object({ notes: z.array(MemoryNote).max(200) }).strict();

export const ToolResult = z
  .object({
    actionId: z.string().uuid(),
    kind: z.enum(['search', 'fetch', 'chats', 'page', 'contact']),
    at: z.string().datetime(),
    ok: z.boolean(),
    /** Present when ok is false. Short, and safe to show a person. */
    error: z.string().max(300).nullable(),
    items: z
      .array(
        z
          .object({
            title: z.string().max(300),
            url: z.string().max(2000),
            published: z.string().max(40).nullable(),
            /** Untrusted text from the page. Capped so one page cannot fill a context. */
            text: z.string(),
          })
          .strict(),
      )
      /**
       * Generous, because two callers with different shapes share this type.
       * A search returns at most ten items but each carries up to 4000
       * characters of page text; the chat listing returns many more items that
       * are a name and a key apiece. This bound was 10, which silently made a
       * listing of more than ten chats fail to parse — and a `chats` request
       * that produces no answer file is indistinguishable, from inside the
       * agent, from the feature being switched off.
       */
      .max(40),
  })
  .strict();

/**
 * What the operator's terminal is asking for.
 *
 * Written by the bridge, read by the agent. The agent captures a pane only
 * while `watchUntil` is in the future, so nobody pays for a screen capture loop
 * that no human is looking at.
 *
 * `keySeq` is what makes key delivery exactly-once across a polling boundary:
 * the agent records the last sequence it applied and ignores anything at or
 * below it, so a file read twice does not type twice.
 */
/**
 * Token spend over three rolling windows.
 *
 * Counted from the agent's own Claude Code transcripts, which is the only place
 * the numbers exist — the bridge never talks to the model API and has nothing to
 * meter. Cache reads are kept separate from input because they are billed
 * differently and lumping them together makes a cached session look far more
 * expensive than it was.
 */
export const UsageWindow = z
  .object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    cacheWrite: z.number().int().nonnegative(),
    cacheRead: z.number().int().nonnegative(),
    /** Assistant messages counted, not WhatsApp turns — one turn is several. */
    replies: z.number().int().nonnegative(),
  })
  .strict();

export const UsageReport = z
  .object({
    at: z.string().datetime(),
    hour: UsageWindow,
    day: UsageWindow,
    week: UsageWindow,
    /** Busiest models first. Capped: this is a display, not an audit log. */
    models: z
      .array(z.object({ name: z.string().max(64), tokens: z.number().int().nonnegative() }).strict())
      .max(8),
  })
  .strict();

export const TerminalRequest = z
  .object({
    /** tmux window to show — `c-<chatKey>`, or null for whichever is active. */
    window: z.string().max(64).nullable(),
    /** Capture while this is in the future. ISO 8601. */
    watchUntil: z.string().datetime(),
    /** Monotonic. The agent applies keys only when this exceeds what it has seen. */
    keySeq: z.number().int().nonnegative(),
    /**
     * Keys to type, in tmux `send-keys` terms — literal text, or a key name
     * such as `Enter` or `C-c`.
     *
     * This types into a live conversation with a member of the public. It is
     * gated by the panel's token and by whatever authenticates in front of it,
     * and the panel says so before it will send anything.
     */
    keys: z.array(z.object({ text: z.string().max(2000), literal: z.boolean() }).strict()).max(32),
  })
  .strict();

/** The captured pane, written by the agent for the panel to display. */
export const TerminalScreen = z
  .object({
    at: z.string().datetime(),
    window: z.string().max(64).nullable(),
    /** Every window the agent currently has open, for the picker. */
    windows: z.array(z.string().max(64)).max(64),
    /** Rendered pane text. Capped: this is displayed, not stored. */
    content: z.string().max(40_000),
    /** The highest keySeq the agent has applied. Lets the panel show delivery. */
    keySeq: z.number().int().nonnegative(),
  })
  .strict();

// ─── Inferred types ──────────────────────────────────────────────────────────

export type ChatKey = z.infer<typeof ChatKey>;
export type TurnId = z.infer<typeof TurnId>;
export type MediaKind = z.infer<typeof MediaKind>;
export type InboundMedia = z.infer<typeof InboundMedia>;
export type InboundMessage = z.infer<typeof InboundMessage>;
export type InboxBatch = z.infer<typeof InboxBatch>;
export type CurrentTurn = z.infer<typeof CurrentTurn>;
export type OutboxAction = z.infer<typeof OutboxAction>;
export type AgentStatus = z.infer<typeof AgentStatus>;
export type MemoryNote = z.infer<typeof MemoryNote>;
export type MemoryFile = z.infer<typeof MemoryFile>;
export type ToolResult = z.infer<typeof ToolResult>;
export type UsageWindow = z.infer<typeof UsageWindow>;
export type UsageReport = z.infer<typeof UsageReport>;
export type TerminalRequest = z.infer<typeof TerminalRequest>;
export type TerminalScreen = z.infer<typeof TerminalScreen>;
