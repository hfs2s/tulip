/**
 * The languages the speech provider will tune a voice for.
 *
 * Here in `shared` rather than in the bridge because both halves need it, and
 * for different reasons. The bridge validates what an operator saves in the
 * panel; the agent's own CLI validates what it types on a `--language` flag,
 * which is what turns a typo into an immediate error it can read and correct
 * rather than a voice note that silently arrives as text an hour later.
 *
 * Transcribed from MiniMax's reference, not guessed. A value it does not
 * recognise fails the whole synthesis request, and the failure looks like a
 * broken voice rather than a bad setting.
 *
 * `Chinese,Yue` carries a comma in the middle. That is the provider's spelling
 * of Cantonese and not a mistake here; anything splitting this list on commas
 * produces two languages that do not exist.
 */
import { z } from 'zod';

export const LANGUAGE_BOOSTS = [
  'auto',
  'Afrikaans', 'Arabic', 'Bulgarian', 'Catalan', 'Chinese', 'Chinese,Yue', 'Croatian',
  'Czech', 'Danish', 'Dutch', 'English', 'Filipino', 'Finnish', 'French', 'German',
  'Greek', 'Hebrew', 'Hindi', 'Hungarian', 'Indonesian', 'Italian', 'Japanese',
  'Korean', 'Malay', 'Norwegian', 'Nynorsk', 'Persian', 'Polish', 'Portuguese',
  'Romanian', 'Russian', 'Slovak', 'Slovenian', 'Spanish', 'Swedish', 'Tamil',
  'Thai', 'Turkish', 'Ukrainian', 'Vietnamese',
] as const;

/** One of them, or empty for whatever the deployment is set to. */
export const LanguageBoost = z
  .string()
  .max(32)
  .refine((v) => v === '' || (LANGUAGE_BOOSTS as readonly string[]).includes(v), {
    message: 'not a language the speech provider recognises',
  });
