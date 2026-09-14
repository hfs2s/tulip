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
import { LanguageBoost } from './languages.js';
import { ScheduleSpec, TimeZone } from './schedule.js';

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

// ─── Callable plugins ────────────────────────────────────────────────────────
//
// Shared rather than written twice because three readers enforce them: the
// bridge's config and manifest parsers, this file's `pluginCall` action, and
// the agent's CLI and MCP tool, which refuse a bad name before anything is
// queued. See bridge/src/pluginCalls.ts.

/** A plugin's name, which is also its directory under the plugins mount. */
export const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** One action a plugin offers, as its manifest names it. Same shape as a plugin name. */
export const PLUGIN_ACTION = PLUGIN_NAME;
/** An argument's name. A leading letter, so it can never be read as a flag or a number. */
export const PLUGIN_ARG_NAME = /^[a-z][a-zA-Z0-9_]{0,39}$/;
export const PLUGIN_MAX_ARGS = 10;
export const PLUGIN_MAX_ARG_CHARS = 2000;
/**
 * The longest an operator may let a plugin take to answer. The agent's own wait
 * is set from this, so a slow plugin is reported as slow rather than the call
 * vanishing on the agent's side first.
 */
export const PLUGIN_MAX_TIMEOUT_MS = 300_000;

/**
 * Named arguments for one plugin call — strings only, and few of them.
 *
 * Strings because the plugin is a separate program in whatever language its
 * author chose, and a string is the one type every one of them reads the same
 * way. Named rather than positional so the bridge can check each name against
 * what the plugin's manifest declared.
 */
export const PluginArgs = z
  .record(z.string().regex(PLUGIN_ARG_NAME, 'an argument name: a letter, then letters, digits or _'), z.string().max(PLUGIN_MAX_ARG_CHARS))
  .refine((a) => Object.keys(a).length <= PLUGIN_MAX_ARGS, `at most ${String(PLUGIN_MAX_ARGS)} arguments`);

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
 * A line the room said before the message that woke the agent.
 *
 * In `mention` and `trigger` groups the gate hands over only what addressed
 * Juan, so "what do you think of this?" arrives with no "this". The bridge
 * already records everything said in a room it is in, and these are the last
 * few lines of it. `heard` is false for a line the gate held back: it was said
 * in the room, not to Juan, and must never be quoted back as if it had been.
 */
export const ContextMessage = z
  .object({
    /** A display name, or `you` for the agent's own earlier replies. Attacker-controlled. */
    from: z.string().max(128),
    at: z.string().datetime(),
    text: z.string().max(1000),
    heard: z.boolean(),
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
    /**
     * Oldest first. Only in `mention` and `trigger` groups — a direct chat and
     * an `observe` room already deliver every message, so there is nothing
     * missing to fill in.
     */
    context: z.array(ContextMessage).max(30).optional(),
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
    /**
     * How talkative to be in this group, 0–4. Absent for a direct chat.
     *
     * Carried per turn rather than in the brief so that moving the slider takes
     * effect on the next message instead of the next session — a dial an
     * operator has to restart the agent to feel is a dial they will not use.
     */
    reactivity: z.number().int().min(0).max(4).nullable().default(null),
    startedAt: z.string().datetime(),
    /**
     * This chat's context generation, bumped by `!reset`.
     *
     * The agent's session id is derived from the chat key *and* this number, so
     * raising it starts a fresh Claude Code session — new context, and a
     * `CLAUDE.md` regenerated from the current persona files.
     *
     * It has to travel here. It used to be read from an environment variable in
     * the agent, which meant the bridge's per-chat counter reached nothing:
     * `!reset` reported a new generation, changed a number on the bridge's disk,
     * and the agent carried on with the same session. The command worked in
     * every respect except the one it was for.
     */
    generation: z.number().int().nonnegative().default(0),
    /**
     * The wall clock the people in this conversation are actually living on.
     *
     * The agent had no time information at all before this existed, and the
     * container runs UTC — so `date` in its shell reads two hours behind a
     * person in Madrid, and "remind us at 9am" quietly became 9am UTC, which is
     * 11am to them. That is a promise broken by two hours with nobody able to
     * see why.
     *
     * Carried per turn like `reactivity`, and from the same reasoning: an
     * operator changing the deployment's zone should not have to restart a
     * session for it to take effect.
     *
     * Defaults to `UTC` so a `current.json` written by an older bridge still
     * parses. That default is *wrong* for this deployment, deliberately and
     * visibly: every verb that resolves a time echoes the zone back with the
     * resolved instant, so falling back to UTC shows up in the confirmation
     * rather than on the day the reminder does not arrive.
     */
    timezone: TimeZone.default('UTC'),
    /**
     * Which capabilities are switched on for this turn.
     *
     * Advisory, and deliberately so: the bridge refuses a switched-off action
     * whatever this says, because it is written into a file the agent reads and
     * a compromised agent could ignore it entirely. It is here to stop the
     * *honest* failure, which is the common one — the agent plans a reply
     * around a picture, sends the action, and gets nothing back, because a refusal
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
        search: z.boolean().default(true),
        crossChat: z.boolean().default(true),
        /**
         * Defaults to *false*, unlike everything above it.
         *
         * The others default true so an older `current.json` still lets the
         * agent try and be refused by the bridge, which reads the real config.
         * That direction is safe for a capability that sends something. It is
         * not safe for one that reads somebody else's conversation, so this one
         * defaults closed and an older file means "no".
         */
        recall: z.boolean().default(false),
        /**
         * Defaults true, like the sending capabilities above it.
         *
         * The direction is safe for the same reason: an older `current.json`
         * lets the agent try, and the bridge — which reads the real config —
         * refuses. And here the refusal is *loud* rather than silent, because
         * the failure being designed against is a promise that cannot be kept:
         * `tulip-wa remind` prints the reason and exits non-zero, so the agent
         * has the words to relay instead of a reminder it thinks it set.
         */
        schedule: z.boolean().default(true),
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
 * performs only the actions below. A picture is a *description*, not a URL, for
 * the same reason.
 *
 * A recipient is the one exception, and it is worth stating precisely because
 * it used to be on that list. Actions default to `turnId`, which the bridge
 * resolves through a map the agent cannot write. `sendTo`, `file`, `image` and
 * `voice` may name a chat instead — but only by a key the bridge itself
 * issued, only when an operator has switched `agent.crossChat` on, and none of
 * them can *read* the chat it names. Reach is the same for all four;
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
       * Read another conversation's recent messages.
       *
       * The one action that fetches inward, and the only one that can put
       * somebody else's words in front of the person being answered. Every
       * other capability here carries the current chat outward.
       *
       * Refused unless the operator has switched recall on, the turn carries
       * operator authority, and the asking chat is not a group — see
       * `canRecall` in shared/src/recall.ts, which is where the reasoning
       * lives. The check is on the bridge, not here: this schema describes what
       * may be *asked*, and the agent is hostile input.
       */
      kind: z.literal('history'),
      /** Whose conversation to read. A key from `tulip-wa chats`, never a number. */
      chatKey: ChatKey,
      /** How far back. Capped low: this is for recall, not for bulk reading. */
      limit: z.number().int().min(1).max(50).default(20),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      turnId: TurnId,
      /**
       * What actually left, according to the bridge.
       *
       * The agent cannot see its own sends. It writes an action, the bridge
       * deletes the file whether it delivered the message or discarded it, and
       * those two outcomes are the same observation from inside the container —
       * so "queued and consumed, no refusals" gets reported as success even
       * when nothing was sent. That has happened, to a message an operator had
       * asked for, and the operator found out from the panel rather than from
       * the agent.
       *
       * Deliberately **outbound only**. What the agent said is its own work and
       * safe to hand back; what other people said is not, and reading another
       * conversation inward is the thing session isolation exists to prevent.
       * See THREAT-MODEL.md §T4.
       */
      kind: z.literal('sent'),
      /** Which conversation. Null is the one whose turn this is. */
      chatKey: ChatKey.nullable().default(null),
      n: z.number().int().min(1).max(50).default(15),
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
       * Leave a WhatsApp group, because an operator asked.
       *
       * The second action, after `contact`, whose control is provenance rather
       * than a switch: the bridge refuses it unless the turn is an operator's,
       * which the dispatcher decided from the sender's jid before the agent saw
       * anything. A member who wants Juan quiet has `!stopjuan`, which works at
       * once and is undone by an operator. Leaving is harder to undo — only
       * somebody still in the group can add him back — which is why it is not
       * something a room can talk the agent into.
       *
       * Deliberately not `Destination`, though it has the same shape. Naming a
       * group here sends it nothing of the agent's choosing beyond the goodbye,
       * so `agent.crossChat` has no say in it: an operator in their direct
       * message naming the group is the ordinary case, and it must not depend
       * on a switch that governs something else.
       */
      kind: z.literal('leaveGroup'),
      /** Which group. Null is the chat whose turn this is. A group either way, or refused. */
      chatKey: ChatKey.nullable().default(null),
      /**
       * Said to the group before leaving, as an ordinary message. Carried on
       * this action rather than sent separately because the order matters and
       * cannot be recovered: once Juan has left, nothing he writes reaches the
       * room. Capped well below `text`, because a goodbye is a line, not a
       * speech.
       */
      goodbye: z.string().min(1).max(1000).nullable().default(null),
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
       * Ask the bridge to send something into *this* chat, later.
       *
       * **Note what is missing: there is no `chatKey` field.** Not a nullable
       * one, not a defaulted one — none at all, so a scheduled send to another
       * conversation is unrepresentable rather than refused. That is a stronger
       * statement than the one `sendTo` makes, and it is deliberate: a delayed
       * cross-chat send is a far better spam primitive than an immediate one.
       * `sendTo` at least happens while a turn is open, an operator can watch
       * the feed move, and the conversation that caused it is on the screen. A
       * message that leaves at three in the morning, from a rule set weeks
       * earlier, in a chat nobody is looking at, has none of that.
       *
       * The bridge stamps the entry with the turn's own chat and nothing else,
       * exactly as `text` is addressed. See bridge/src/schedule.ts.
       *
       * A *tool* rather than a send: it delivers nothing at the moment it is
       * called. It spends the turn's tool budget, like `remember` and `search`,
       * for the reason `outbox.ts` sets out where the two budgets are charged.
       * The eventual delivery spends the destination chat's outbound rate, on
       * the day it happens, like any other message.
       */
      kind: z.literal('schedule'),
      spec: ScheduleSpec,
      /** Capped like `text`, and for the same reason — see that action. */
      text: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      turnId: TurnId,
      /**
       * Call one off.
       *
       * Scoped to the asking chat on the bridge side: an id belonging to
       * somebody else's conversation is answered as "no such reminder", which
       * is also what an invented id gets. Ids are v4 UUIDs, so guessing one is
       * not a route in, and the check means a guess would buy nothing anyway.
       */
      kind: z.literal('scheduleCancel'),
      scheduleId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      turnId: TurnId,
      /**
       * What has been promised to the people in this chat.
       *
       * The agent cannot see its own store — the file is on the bridge's own
       * volume, which it has no mount for — so without this it would have to
       * remember what it had set up, across sessions, which is exactly the kind
       * of thing it does not reliably do. Returns this chat's entries and no
       * others.
       */
      kind: z.literal('scheduleList'),
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
      /**
       * Take a page down, reversibly.
       *
       * Unpublishing rather than deleting, because this arrives as a sentence
       * in a chat, is acted on by a model, and nobody is looking at a confirm
       * dialog. The files stay; only the panel removes anything for good.
       */
      kind: z.literal('pageDelete'),
      slug: z.string().min(3).max(48).regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes'),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      turnId: TurnId,
      /**
       * Put a password in front of a page, or take one off.
       *
       * The bridge hashes it and keeps only the hash — the agent's container is
       * the one an attacker is assumed to own, and this action is the last
       * moment the plaintext exists anywhere the agent can see. An empty string
       * removes the password, which is why it is not `.min(1)`.
       */
      kind: z.literal('pagePassword'),
      slug: z.string().min(3).max(48).regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes'),
      password: z.string().max(128),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      turnId: TurnId,
      /**
       * Ask another agent on this host a question.
       *
       * The peer is named by *handle*, never by number: the bridge resolves it,
       * so the standing rule holds — a destination is this turn's chat or
       * something the trusted side named, never digits the agent produced.
       *
       * Operator turns only, and never from inside an exchange with another
       * agent. See bridge/src/peers.ts for why both are structural.
       */
      kind: z.literal('peerAsk'),
      peer: z.string().regex(/^[a-z][a-z0-9-]{1,23}$/, 'a peer handle from the peers listing'),
      text: z.string().min(1).max(1500),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      turnId: TurnId,
      /**
       * Name an hfs2s app, or clear its name.
       *
       * The box names its own workspaces and most of them have no name at all;
       * nothing the agent can reach changes that, so the label is kept on this
       * side and shown wherever the app is named. An empty label clears it.
       *
       * Governed by `apps.grants` like every other workspace verb: naming
       * somebody's app is a small act, and it is still their app.
       */
      kind: z.literal('appLabel'),
      workspace: z.string().regex(/^[0-9a-f]{8}$/, 'an eight-character workspace id'),
      label: z.string().max(60),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      turnId: TurnId,
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
      /**
       * Pictures to work from, named as they arrive in the batch.
       *
       * Each is a `media/<chatKey>/<file>` path, and the bridge accepts only
       * ones inside *this turn's own chat* — a path naming another
       * conversation's photo is refused there rather than trusted here. The
       * provider is handed the bytes, never a link: these live on a volume
       * with no public address, and publishing them to make a URL is the
       * opposite of what the agent was asked for.
       */
      refs: z.array(z.string().max(200)).max(16).default([]),
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
      /**
       * The mouth the words are spoken with, for this message only.
       *
       * Not the language of the text — the agent already chooses that by
       * writing in it — but the accent it is read with. Without it a Spanish
       * sentence is pronounced by whatever the deployment is set to, and a bot
       * that answers a Barcelona group and a Filipino one on the same evening
       * is wrong for one of them whichever way the setting points.
       *
       * Empty falls back to the operator's setting, so a message that says
       * nothing about language behaves exactly as it did before this existed.
       */
      language: LanguageBoost.default(''),
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
       * Constrained to http(s) here, and the bridge never dials it. It hands
       * it to `tulip-browser` — a separate, untrusted container whose only
       * route is a proxy that refuses private addresses — and failing that,
       * asks the search provider for its copy. That distinction is the whole
       * safety argument: a bridge that fetched agent-chosen URLs itself would
       * be a server-side request forgery gadget sitting on both networks. See
       * bridge/src/browse.ts and bridge/src/exa.ts.
       */
      url: z.string().url().max(2000).refine((u) => /^https?:\/\//i.test(u), 'must be http or https'),
      /**
       * Also bring back a picture of the page (`--look`). Only the browser can
       * take one; when the answer comes from the search provider there is none.
       *
       * Defaulted, so an agent built before this field existed still sends a
       * valid action. The other direction does not hold — the schema is strict,
       * so a bridge that predates it rejects an action carrying it — which is
       * why the bridge is deployed first.
       */
      screenshot: z.boolean().default(false),
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
  /**
   * Correct something already said.
   *
   * `nth` is a position in the agent's own recent messages in *this* chat —
   * 1 is the last thing it said — never a WhatsApp message id. That asymmetry
   * is deliberate and is the whole security argument for exposing this at all:
   * an id is an opaque string the agent could be talked into repeating by
   * anybody who types one at it, whereas a small ordinal can only ever resolve
   * to a message Juan sent in the conversation Juan is answering. The bridge
   * does the resolving, against a store the agent has no mount for.
   * See bridge/src/sent.ts.
   */
  z
    .object({
      id: z.string().uuid(),
      turnId: TurnId,
      kind: z.literal('edit'),
      nth: z.number().int().min(1).max(20),
      text: z.string().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      turnId: TurnId,
      kind: z.literal('unsend'),
      nth: z.number().int().min(1).max(20),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      turnId: TurnId,
      /**
       * Which services on the host this turn may ask things of.
       *
       * Answered from config and each plugin's own manifest. A plugin the
       * operator marked `operatorOnly` is left out unless the turn carries
       * operator authority, so the listing is what this conversation can
       * actually use rather than a list of things it will be refused.
       */
      kind: z.literal('pluginList'),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      turnId: TurnId,
      /**
       * Ask one plugin to do one thing, and wait for its answer.
       *
       * Note what this cannot say: a path, a URL, a command, or anything about
       * *how* the plugin does its work. It names a plugin the operator enabled,
       * one action that plugin's manifest lists, and arguments that action
       * declares — the bridge checks all three, and whether the turn is an
       * operator's, before it writes anything. What the plugin then does is
       * only what its own service implements. See bridge/src/pluginCalls.ts.
       */
      kind: z.literal('pluginCall'),
      plugin: z.string().regex(PLUGIN_NAME, 'a plugin name from `tulip-wa plugins`'),
      action: z.string().regex(PLUGIN_ACTION, 'an action name from `tulip-wa plugins`'),
      args: PluginArgs.default({}),
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
            /**
             * Display only, and deliberately NOT `ChatKey`.
             *
             * It was, and that broke the moment sessions stopped being per chat:
             * the agent reports the shared session as `main`, which is not 16 hex
             * characters, so every status write failed validation and the agent
             * silently stopped reporting at all. Nothing routes on this value —
             * delivery is resolved from `turnId` — so a loose string is right,
             * and a strict one bought nothing but an outage.
             */
            chatKey: z.string().min(1).max(64),
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
    kind: z.enum([
      'search', 'fetch', 'chats', 'page', 'contact', 'sent', 'history', 'schedule', 'edit', 'unsend', 'leaveGroup',
      // Both plugin actions. A kind an older agent does not know only reaches
      // an agent new enough to have asked for it, so adding one is safe.
      'plugin',
      // Naming an hfs2s app. Same reasoning as `plugin` above.
      'app',
      // Asking another agent. Same reasoning again.
      'peer',
    ]),
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
