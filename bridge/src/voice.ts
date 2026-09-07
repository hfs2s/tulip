/**
 * Which mouth reads a language, decided in one place.
 *
 * Three settings decide how a voice note sounds — the row's `boost`, the voice
 * chosen for that row, and the deployment's fallback voice — and they are
 * combined in a specific order that is not obvious from any one of them. That
 * expression used to live inline in `outbox.ts` and nowhere else, which was
 * fine while there was one caller.
 *
 * There are two now: the outbound path, and the panel's voice test bench. The
 * bench exists so an operator can hear what a real voice note will sound like,
 * and it is worth nothing at all if the two paths resolve differently — a bench
 * that plays the default voice while the agent uses the per-language one is
 * worse than no bench, because it is confidently wrong. So both call this, and
 * the equivalence is by construction rather than by two copies that agree
 * today.
 */
import { LANGUAGE_LIMITS, isUnspoken, spokenLanguageFor } from '@tulip/shared';
import type { Config } from './config.js';

export interface ResolvedVoice {
  /** The `language_boost` the request carries. */
  readonly boost: string;
  /** The voice id to speak with. Empty means the provider's own default. */
  readonly voiceId: string;
  /** The row that was matched, or null if the language is not one we speak. */
  readonly spoken: { readonly name: string; readonly boost: string } | null;
  /** True when the row exists but has no voice of its own, so the fallback reads it. */
  readonly usingFallback: boolean;
}

/**
 * Resolve a spoken language to the boost and voice a request should carry.
 *
 * `language` is the message's own choice; empty falls back to the operator's
 * deployment-wide setting, which is the ordinary case for a note written before
 * the agent started naming languages.
 *
 * A language with no row is still sent: the provider accepts far more boosts
 * than this deployment has opinions about, and refusing one here would turn a
 * pronunciation improvement into a failed voice note.
 */
export function resolveVoice(config: Config, language: string): ResolvedVoice {
  const asked = language.trim().length > 0 ? language : config.agent.languageBoost;
  const spoken = spokenLanguageFor(asked);
  const boost = spoken?.boost ?? asked;
  const perLanguage = spoken === null ? '' : (config.agent.voices[spoken.name] ?? '').trim();
  const voiceId = perLanguage || config.agent.voiceId;
  return { boost, voiceId, spoken, usingFallback: perLanguage.length === 0 };
}

/**
 * Should this be written rather than spoken?
 *
 * The provider tunes pronunciation for more languages than it has usable mouths
 * for, and this deployment has withdrawn a few more on top of that. Swedish is
 * the clearest case: there is a `language_boost` and not one Swedish voice, so
 * a "Swedish voice note" was a Spanish or English mouth sounding out Swedish
 * words with the vowels nudged. That is not an accent, it is an impression —
 * and it is worse than not speaking, because a text message loses only the
 * audio while this loses the credibility of everything around it.
 *
 * So the caller sends the words as text, which is the same fallback a synthesis
 * failure and a spent daily allowance already take: **the message is never
 * lost, only the audio.**
 *
 * **Keyed on the boost, not on the row, and that is the whole correctness
 * argument.** An earlier version asked whether the *row* was flagged, which
 * quietly meant a language with no row was always spoken — so withdrawing
 * Vietnamese and Turkish from `SPOKEN_LANGUAGES` removed them from the panel
 * and left them being read aloud by whichever default voice was configured.
 * Removing a row is a statement about what an operator can configure; it is not
 * a statement about what leaves the building. `UNSPOKEN_BOOSTS` is the second.
 *
 * The operator override still wins where it can exist: naming a voice for a row
 * — a cloned one, or one the catalogue gained since that table was written — is
 * choosing a mouth, and this must not overrule it. That path is only reachable
 * for a language that *has* a row, which is the correct shape: to start
 * speaking a withdrawn language you add the row back and take it off the list.
 *
 * A language that is merely unfamiliar is *not* unspoken. The provider accepts
 * far more boosts than this deployment has opinions about, and treating an
 * unknown one as unspeakable would silently demote most of the world to text.
 */
export function voiceless(resolved: ResolvedVoice): boolean {
  // An explicitly chosen mouth always wins.
  if (!resolved.usingFallback) return false;
  if (isUnspoken(resolved.boost)) return true;
  if (resolved.spoken === null) return false;
  return LANGUAGE_LIMITS[resolved.spoken.name as keyof typeof LANGUAGE_LIMITS]?.voiceless === true;
}
