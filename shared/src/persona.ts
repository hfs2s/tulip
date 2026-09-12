/**
 * The persona as a setting: four named parts, edited in the panel, handed to
 * the agent through the inbound volume.
 *
 * The bridge owns the saved copy and publishes it; the agent composes its brief
 * from what was published. Both sides need the same order, the same join and
 * the same version, so all three live here rather than in either half.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Assembled in this order: who it is, how it talks, how it works, what it will not do. */
export const PERSONA_PARTS = ['IDENTITY.md', 'VOICE.md', 'OPERATING.md', 'BOUNDARIES.md'] as const;
export type PersonaPart = (typeof PERSONA_PARTS)[number];

export function isPersonaPart(name: string): name is PersonaPart {
  return (PERSONA_PARTS as readonly string[]).includes(name);
}

/**
 * The size the whole brief should stay under — persona, remembered notes and
 * the clock together. Claude Code's own threshold for a `CLAUDE.md`. Reported,
 * not enforced: the persona is most of it, and what to cut is an editorial
 * decision the panel can inform but should not make.
 */
export const BRIEF_LIMIT_CHARS = 40_000;

/**
 * Hard ceiling on one saved part. A bound on a runaway paste, not an editorial
 * limit. Below the panel's 64,000-character request cap with room for JSON
 * escaping, so a part this size is refused with a reason rather than by a body
 * that never arrives.
 */
export const PART_MAX_CHARS = 48_000;

export const PersonaFile = z
  .object({
    /** `personaVersion` of the composed text. What the agent compares before each turn. */
    version: z.string().regex(/^[0-9a-f]{16}$/),
    at: z.string().datetime(),
    parts: z
      .array(
        z
          .object({
            name: z.enum(PERSONA_PARTS),
            text: z.string().max(PART_MAX_CHARS),
            /** Saved by an operator, or the starter shipped in `persona/`. Display only. */
            source: z.enum(['saved', 'starter']),
          })
          .strict(),
      )
      .max(PERSONA_PARTS.length),
  })
  .strict();
export type PersonaFile = z.infer<typeof PersonaFile>;

/** The parts, in order, as they appear in the brief. An empty part is left out. */
export function composePersona(parts: ReadonlyArray<{ readonly name: PersonaPart; readonly text: string }>): string {
  return PERSONA_PARTS.map((name) => parts.find((p) => p.name === name)?.text.trim() ?? '')
    .filter((text) => text.length > 0)
    .join('\n\n---\n\n');
}

/** Stable for identical text, so re-publishing an unchanged persona does not restart anything. */
export function personaVersion(composed: string): string {
  return createHash('sha256').update(composed).digest('hex').slice(0, 16);
}
