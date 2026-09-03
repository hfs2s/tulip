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
  })
  .strict()
  .default({});

const Groups = z
  .object({
    /**
     * Off by default. A public assistant added to a group answers people who
     * never chose to talk to it, in a room whose other members it cannot see
     * the history of. That is a product decision as much as a security one.
     */
    enabled: z.boolean().default(false),
    replyTo: z.enum(['mention', 'trigger']).default('mention'),
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
    /** A turn that outlives this is abandoned so it cannot hold the queue shut. */
    turnTimeoutMs: z.number().int().min(30_000).max(3_600_000).default(600_000),
  })
  .strict()
  .default({});

const Panel = z
  .object({
    enabled: z.boolean().default(true),
    /**
     * Loopback by default. The panel is a bearer-token surface that can read
     * every message and restart sessions; publishing it is an explicit decision,
     * and `scripts/preflight.sh` refuses a deployment that binds it wider by
     * accident.
     */
    host: z.string().default('127.0.0.1'),
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

export const ConfigSchema = z
  .object({
    audience: Audience,
    operators: Operators,
    groups: Groups,
    limits: Limits,
    panel: Panel,
    delivery: Delivery,
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Parse and validate. Unknown keys are an error rather than being ignored: a
 * typo in a security-relevant key would otherwise leave the default silently in
 * force while the operator believes they have changed it.
 */
export function parseConfig(raw: unknown): Config {
  const result = ConfigSchema.safeParse(raw);
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
