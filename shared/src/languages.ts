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

/**
 * Names a person would reach for, mapped to the one the provider accepts.
 *
 * The agent picks a language by thinking about what it just wrote, and what it
 * writes has names the provider has never heard of. Cebuano is the live example:
 * Juan is learning Bisaya, so "Bisaya" and "Cebuano" are the words in front of
 * him, and both are refused — the request fails outright rather than degrading,
 * and the reply arrives as text with no explanation.
 *
 * Two kinds of entry, and the difference is worth being honest about:
 *
 *   · **Spellings of the same language.** Castilian is Spanish, Farsi is
 *     Persian, Bahasa is Indonesian. Nothing is lost here.
 *   · **The nearest available mouth.** Cebuano is not Filipino, and Valencian
 *     is not quite Catalan. The provider has no voice for either, so this picks
 *     the closest one it does have rather than failing. That is a real
 *     approximation and it is made deliberately: a Cebuano sentence read with a
 *     Filipino mouth is right about the vowels and the stress, which is most of
 *     what makes it sound like itself. Read with an English one it sounds
 *     American, which is the bug this exists to prevent.
 *
 * Automatic detection is *not* a substitute. It routinely hears Filipino and
 * Cebuano as Malay or Indonesian — close enough to be plausible and wrong
 * enough to be noticed — which is why naming the language is required.
 */
export const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  // Philippine languages. The provider has one Austronesian mouth for all of
  // them and it is the right one to use; `auto` reaches for Malay instead.
  tagalog: 'Filipino',
  pilipino: 'Filipino',
  bisaya: 'Filipino',
  binisaya: 'Filipino',
  visayan: 'Filipino',
  cebuano: 'Filipino',
  ilocano: 'Filipino',
  hiligaynon: 'Filipino',
  ilonggo: 'Filipino',
  bikol: 'Filipino',
  waray: 'Filipino',
  taglish: 'Filipino',

  // Spain, which is where Juan actually lives.
  valencian: 'Catalan',
  valencia: 'Catalan',
  mallorquin: 'Catalan',
  castilian: 'Spanish',
  castellano: 'Spanish',
  'español': 'Spanish',
  espanol: 'Spanish',
  galician: 'Spanish',
  spanglish: 'Spanish',

  // Ordinary other names for the same thing.
  mandarin: 'Chinese',
  putonghua: 'Chinese',
  cantonese: 'Chinese,Yue',
  yue: 'Chinese,Yue',
  farsi: 'Persian',
  bahasa: 'Indonesian',
  'bahasa indonesia': 'Indonesian',
  brazilian: 'Portuguese',
  'português': 'Portuguese',
  portugues: 'Portuguese',
  flemish: 'Dutch',
  automatic: 'auto',
  detect: 'auto',
};

/**
 * The value to send for whatever the agent typed, or null.
 *
 * Case-insensitive, because "filipino" and "Filipino" are the same intention
 * and refusing one of them teaches nothing. An exact member of the list wins
 * before an alias is considered, so this can never rename something valid.
 */
export function resolveLanguage(input: string): string | null {
  const raw = input.trim();
  if (raw.length === 0) return null;
  const exact = (LANGUAGE_BOOSTS as readonly string[])
    .find((l) => l.toLowerCase() === raw.toLowerCase());
  if (exact !== undefined) return exact;
  return LANGUAGE_ALIASES[raw.toLowerCase()] ?? null;
}

/**
 * The languages this deployment actually speaks, and the mouth each is read
 * with.
 *
 * A separate list from `LANGUAGE_BOOSTS`, which is everything the provider will
 * accept. This is the shorter one an operator has opinions about — and it is
 * keyed on what the agent *says* rather than on what goes to the API, which is
 * the whole reason it exists: Cebuano and Filipino are boosted identically,
 * because the provider has one Austronesian mouth, but an operator may well
 * want a different voice reading each of them. Collapsing them at the point of
 * lookup would make that unsayable.
 *
 * So a row is a spoken language; `boost` is what the request carries, and the
 * voice is chosen per row in the panel.
 */
export const SPOKEN_LANGUAGES = [
  { name: 'English', boost: 'English' },
  { name: 'Filipino', boost: 'Filipino' },
  { name: 'Cebuano', boost: 'Filipino' },
  { name: 'Catalan', boost: 'Catalan' },
  { name: 'Spanish', boost: 'Spanish' },
  { name: 'Portuguese', boost: 'Portuguese' },
  { name: 'French', boost: 'French' },
  { name: 'Italian', boost: 'Italian' },
] as const;

export type SpokenLanguage = (typeof SPOKEN_LANGUAGES)[number]['name'];

/**
 * The row for whatever the agent typed, or null.
 *
 * Case-insensitive, and aware of the alias table — so "bisaya" finds the
 * Cebuano row rather than being folded into Filipino before anybody can choose
 * a voice for it. An exact row name always wins first.
 */
export function spokenLanguageFor(input: string): (typeof SPOKEN_LANGUAGES)[number] | null {
  const raw = input.trim().toLowerCase();
  if (raw.length === 0) return null;

  const exact = SPOKEN_LANGUAGES.find((l) => l.name.toLowerCase() === raw);
  if (exact !== undefined) return exact;

  // The Philippine names all alias to Filipino for the API, but Cebuano is its
  // own row here, so the regional ones land on it rather than on Filipino.
  const CEBUANO = new Set(['bisaya', 'binisaya', 'visayan', 'cebuano']);
  if (CEBUANO.has(raw)) return SPOKEN_LANGUAGES.find((l) => l.name === 'Cebuano') ?? null;

  const canonical = resolveLanguage(input);
  if (canonical === null) return null;
  return SPOKEN_LANGUAGES.find((l) => l.boost === canonical) ?? null;
}
