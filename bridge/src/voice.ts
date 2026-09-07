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
import { spokenLanguageFor } from '@tulip/shared';
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
