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
 *   1. **The agent never names a destination.** Outbound actions identify a
 *      `turnId`; the bridge holds the only turn → chat mapping and resolves it
 *      itself. A compromised agent has no way to express "send this to someone
 *      else" — the words for it do not exist. See THREAT-MODEL.md §T4.
 *
 *   2. **The agent never sees a phone number.** Chats are identified by an
 *      opaque `chatKey` derived from a salt the agent cannot read. Personal
 *      identifiers stay in the bridge, so a successful exfiltration yields
 *      display names at worst.
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
    /** Why the attachment is missing, when it is. */
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
  })
  .strict();

// ─── Agent → bridge (hostile) ────────────────────────────────────────────────

/**
 * Everything the agent is able to ask for.
 *
 * Note what is absent and cannot be added by an attacker: a recipient, a file
 * path, a shell command, a URL. The bridge derives the destination from
 * `turnId`, opens files only from its own directory, and performs only the
 * actions below. A GIF is a *search phrase*, not a URL, for the same reason.
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
      file: OutFileName,
      caption: z.string().max(1024).nullable(),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      turnId: TurnId,
      kind: z.literal('gif'),
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
export const ToolResult = z
  .object({
    actionId: z.string().uuid(),
    kind: z.enum(['search', 'fetch']),
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
      .max(10),
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
export type ToolResult = z.infer<typeof ToolResult>;
