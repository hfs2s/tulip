/**
 * Configuration, validated at startup.
 *
 * Two deliberate choices:
 *
 *   - **Defaults are the safe end of every range.** Groups off, panel on
 *     loopback, limits low. An operator who omits a key gets the restrictive
 *     behaviour, so a truncated or half-written config cannot accidentally
 *     widen exposure.
 *   - **A malformed config is fatal.** Elsewhere in Tulip failures degrade
 *     quietly, because dropping a message is worse than a slow one. Not here:
 *     this file decides who may talk to a machine holding a shell, and running
 *     with a half-understood version of it is exactly the situation worth
 *     refusing to be in.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';

/** Bare international digits, as WhatsApp stores them. No `+`, no spaces. */
const PhoneNumber = z
  .string()
  .regex(/^[1-9][0-9]{6,15}$/, 'must be bare international digits, without + or spaces');

/**
 * A WhatsApp "linked id" — the identifier WhatsApp increasingly delivers a
 * sender under instead of their phone number.
 *
 * It has to be listable separately because it cannot be derived from anything
 * you know about a person. You find it by looking at what the gate actually
 * saw: `gate.deny` records every identifier the message arrived with, and the
 * panel shows it, precisely so that allowing someone is a copy rather than a
 * guess.
 */
const LinkedId = z
  .string()
  .regex(/^[0-9]{5,25}(@lid)?$/, 'must be a linked id, digits with an optional @lid suffix');

const Audience = z
  .object({
    /**
     * The public switch. `true` means anyone who messages the number is
     * answered, and every inbound message becomes untrusted input to an agent
     * holding a shell. Everything in docs/THREAT-MODEL.md assumes this is on.
     */
    everyone: z.boolean().default(false),
    /** Consulted only when `everyone` is false. */
    numbers: z.array(PhoneNumber).default([]),
    /** Also consulted when `everyone` is false. See LinkedId. */
    jids: z.array(LinkedId).default([]),
  })
  .strict()
  .default({});

const Operators = z
  .object({
    /**
     * Who may run `!` control commands, and who receives watchdog alerts.
     * Never widened by `audience.everyone` — that would hand a stranger the
     * ability to restart sessions and read state.
     */
    numbers: z.array(PhoneNumber).default([]),
    /**
     * The same people, by linked id. Needed more often than the numbers list:
     * an operator messaging from a modern client arrives as a `@lid`, and an
     * operator whose commands are silently ignored has no way in at all.
     */
    jids: z.array(LinkedId).default([]),
  })
  .strict()
  .default({});

const Groups = z
  .object({
    /**
     * Off by default. A public assistant added to a group answers people who
     * never chose to talk to it, in a room whose other members it cannot see
     * the history of. That is a product decision as much as a security one.
     *
     * **Groups do not consult `audience`.** Being in the room is the consent
     * signal — somebody added the bot deliberately — so every member reaches
     * the agent even while `audience.everyone` is false and the allowlist holds
     * one number. That is the intended reading of a group, but it means
     * enabling groups widens who can reach the agent, independently of every
     * other audience setting. Worth knowing before switching it on.
     */
    enabled: z.boolean().default(false),
    /**
     * What reaches the agent from a group.
     *
     *   mention  — only a real @mention or a reply to us
     *   trigger  — that, plus a message containing a trigger word
     *   observe  — everything
     *
     * `observe` exists so the agent can be a *participant*: react to what people
     * say, and answer when addressed. It is the expensive one, because every
     * group message becomes a turn and therefore a model call — a busy group
     * will spend a great deal of them. It also means the agent sees everything
     * said in that room, which is a privacy decision the group should know
     * about, not a setting to switch on quietly.
     *
     * It relies on the agent choosing silence most of the time; the persona
     * carries that, and `tulip-wa quiet` is how it says nothing deliberately.
     */
    replyTo: z.enum(['mention', 'trigger', 'observe']).default('mention'),
    triggers: z.array(z.string().min(1).max(32)).max(8).default([]),
  })
  .strict()
  .default({});

const Limits = z
  .object({
    /** Sustained rate per sender, with a small burst for natural typing. */
    messagesPerHour: z.number().int().min(1).max(1000).default(20),
    burst: z.number().int().min(1).max(50).default(5),
    /**
     * Turns are the expensive unit — each is a model call. This is the cost
     * ceiling one person can impose in a day.
     */
    turnsPerDay: z.number().int().min(1).max(10_000).default(40),
    /** Longer messages are truncated, not refused: a long question is not an attack. */
    maxInboundChars: z.number().int().min(200).max(100_000).default(4000),
    /** Checked before download, so an oversized attachment is never fetched. */
    maxMediaBytes: z.number().int().min(1024).max(100 * 1024 * 1024).default(16 * 1024 * 1024),
    maxMediaPerMessage: z.number().int().min(0).max(10).default(4),
    /** Blunts enumeration and bulk onboarding of throwaway numbers. */
    newSendersPerHour: z.number().int().min(1).max(1000).default(30),
    /** Bounds a compromised agent as much as a chatty one. */
    outboundPerTurn: z.number().int().min(1).max(100).default(8),
    outboundPerChatPerHour: z.number().int().min(1).max(1000).default(60),
    /**
     * The three capabilities billed per use, capped across everybody rather
     * than per sender.
     *
     * Every other limit here bounds one person, which is right for a closed
     * list and wrong for a number open to the internet: the bill is not one
     * sender being expensive, it is a hundred each being reasonable. A
     * per-sender cap cannot bound a total, and the total is what arrives as an
     * invoice.
     */
    imagesPerDay: z.number().int().min(0).max(1000).default(40),
    transcriptionsPerDay: z.number().int().min(0).max(5000).default(200),
    /**
     * Speaking was the one billed capability with no ceiling, because it could
     * only ever answer the person in front of it and the conversation bounded
     * it. It can be aimed at another chat now, so it needs its own number.
     *
     * Set high enough that ordinary talking never reaches it — running out is
     * a cost control, not a feature — and note that exceeding it sends the
     * words as text rather than sending nothing.
     */
    voicePerDay: z.number().int().min(0).max(5000).default(200),
    /** A turn that outlives this is abandoned so it cannot hold the queue shut. */
    turnTimeoutMs: z.number().int().min(30_000).max(3_600_000).default(600_000),
  })
  .strict()
  .default({});

const Panel = z
  .object({
    enabled: z.boolean().default(true),
    /**
     * Bind address *inside the container*, which is a different thing from the
     * address it is reachable on — and confusing the two is how this was wrong
     * to begin with.
     *
     * Binding to 127.0.0.1 here does not harden anything; it makes the panel
     * unreachable altogether. Docker forwards a published port to the
     * container's ethernet address, never to its loopback, so a process
     * listening only on 127.0.0.1 inside a container can be reached by nothing
     * but itself.
     *
     * The control that actually limits exposure is the *publish* address in
     * docker-compose.yml — `127.0.0.1:8791:8791`, which puts it on the host's
     * loopback and nowhere else. `scripts/preflight.sh` checks that line,
     * because that is the one that matters.
     */
    host: z.string().default('0.0.0.0'),
    port: z.number().int().min(1).max(65535).default(8791),
  })
  .strict()
  .default({});

const Delivery = z
  .object({
    /** Collects a burst of short messages into one prompt. */
    debounceMs: z.number().int().min(0).max(60_000).default(3000),
    /** Messages per batch; the rest wait for the next turn. */
    maxBatch: z.number().int().min(1).max(50).default(20),
    /** How long a message may sit unanswered before operators are told. */
    stuckAfterMs: z.number().int().min(0).max(3_600_000).default(300_000),
  })
  .strict()
  .default({});

/**
 * One person the agent may approach unprompted.
 *
 * Exported because the panel validates the same shape when an operator edits
 * the list, and two copies of a rule about who a machine may message is exactly
 * the kind of duplication that drifts apart quietly.
 */
export const Contact = z
  .object({
    /** What the agent sees. It never sees the number. */
    label: z.string().min(1).max(64),
    /** Bare international digits, no `+` and no punctuation. */
    number: z.string().regex(/^[0-9]{6,20}$/, 'a contact number must be bare international digits'),
  })
  .strict();

const Agent = z
  .object({
    /**
     * May the agent send to a chat other than the one it is answering?
     *
     * Off by default, and the default is the security story: outbound actions
     * normally carry a turn, the bridge holds the only turn → chat map, and
     * "send this to somebody else" is not expressible. Turning this on adds an
     * action that names a chat, which makes it expressible.
     *
     * What it does *not* undo is session isolation. Each chat is a separate
     * Claude Code session, so the agent still cannot read another conversation —
     * it can carry the current one outward, not fetch someone else's inward.
     * See docs/THREAT-MODEL.md §T4.
     */
    crossChat: z.boolean().default(false),

    /**
     * People the agent may approach who have not written to it first.
     *
     * Without this, `crossChat` is close to decorative. A chat key only exists
     * once somebody has sent a message in, so "message another chat" could only
     * ever reach people already in the middle of a conversation with Tulip —
     * the agent could reply onward, but never introduce itself to anybody. That
     * is not what an operator means when they switch it on.
     *
     * The list is *destinations only*, and deliberately not the audience list.
     * Adding somebody here lets Tulip write to them; it does not let them write
     * to Tulip, which stays governed by `audience`. Keeping the two apart means
     * adding an outbound destination can never widen the inbound attack
     * surface as a side effect — see docs/OPERATIONS.md, "Letting somebody in".
     *
     * It is also the authorisation channel the agent can actually trust. A
     * WhatsApp message asking Tulip to message a third party is unverifiable
     * and is exactly what a prompt injection looks like; an entry here arrives
     * through the panel, which the agent cannot write to. So the persona's rule
     * is not "do as you are told", it is "you may approach the people on this
     * list, and nobody else".
     */
    contacts: z.array(Contact).max(50).default([]),

    /**
     * Capability switches.
     *
     * Separate from whether a key is configured, and that separation is the
     * point: a key lives in the environment and changing it needs a container
     * restart, whereas an operator wanting to stop the bot generating pictures
     * at two in the morning wants a switch. Each is *permission*; the key is
     * *capability*. A feature runs only when it has both.
     */
    search: z.boolean().default(true),
    gifs: z.boolean().default(true),
    images: z.boolean().default(true),
    voice: z.boolean().default(true),
    /**
     * Which voice speaks. Empty means the deployment's own default, so an
     * existing install keeps whatever `MINIMAX_VOICE_ID` gave it.
     *
     * Here rather than in the environment because it is a thing an operator
     * changes and listens to and changes again, and an environment variable
     * costs a container restart for each attempt. A wrong id fails the whole
     * request — MiniMax answers "voice id not exist" — so voice notes fall back
     * to text until it is corrected, which is why the panel says so next to the
     * box.
     */
    voiceId: z.string().max(128).default(''),
  })
  .strict()
  .default({});

export const ConfigSchema = z
  .object({
    audience: Audience,
    agent: Agent,
    operators: Operators,
    groups: Groups,
    limits: Limits,
    panel: Panel,
    delivery: Delivery,
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Strip documentation keys.
 *
 * JSON has no comments, and a configuration file that decides who may talk to a
 * machine holding a shell is exactly the kind that needs them — so keys
 * beginning with `_` are treated as prose and removed before validation.
 *
 * This is the *only* concession to unknown keys, and it is a narrow one: `_note`
 * is dropped, while `audiance` is still a fatal error. That distinction is the
 * point. A typo in a security-relevant key must not leave the restrictive
 * default silently in force while the operator believes they changed it.
 */
function stripComments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripComments);
  if (typeof value !== 'object' || value === null) return value;

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key.startsWith('_')) continue;
    out[key] = stripComments(nested);
  }
  return out;
}

/**
 * Parse and validate. Unknown keys are an error rather than being ignored: a
 * typo in a security-relevant key would otherwise leave the default silently in
 * force while the operator believes they have changed it.
 */
export function parseConfig(raw: unknown): Config {
  const result = ConfigSchema.safeParse(stripComments(raw));
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`invalid configuration:\n${problems}`);
  }
  return result.data;
}

/** Read config from disk. Absent is fine and means "every default". */
export function loadConfig(file: string): Config {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return parseConfig({});
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`configuration at ${file} is not valid JSON: ${(err as Error).message}`);
  }
  return parseConfig(parsed);
}
