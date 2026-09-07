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
  { name: 'Indonesian', boost: 'Indonesian' },
  { name: 'Catalan', boost: 'Catalan' },
  { name: 'Spanish', boost: 'Spanish' },
  { name: 'Portuguese', boost: 'Portuguese' },
  { name: 'French', boost: 'French' },
  { name: 'Italian', boost: 'Italian' },
  // The second nine. Added together, and each one checked against the
  // provider's live catalogue rather than against what its name suggests —
  // which is how the three honest gaps below were found instead of guessed at.
  { name: 'Dutch', boost: 'Dutch' },
  { name: 'German', boost: 'German' },
  /**
   * Swedish is a row with no mouth.
   *
   * The provider has a Swedish `language_boost` and not one Swedish voice, so
   * this row improves how the words are *pronounced* while leaving the accent
   * to whatever the deployment default is. That is a real limitation rather
   * than a setting nobody has filled in yet, and the panel says so on the row —
   * an operator who sees a blank field otherwise reads it as a to-do.
   */
  { name: 'Swedish', boost: 'Swedish' },
  { name: 'Turkish', boost: 'Turkish' },
  { name: 'Arabic', boost: 'Arabic' },
  // Named for what the agent says, boosted with what the provider calls it.
  // `Chinese` is Mandarin here; Cantonese is `Chinese,Yue` and has no row.
  { name: 'Mandarin', boost: 'Chinese' },
  { name: 'Russian', boost: 'Russian' },
  { name: 'Japanese', boost: 'Japanese' },
  /**
   * Vietnamese has exactly one voice in the catalogue and it is female.
   *
   * Every other row here is read by a man, because that is who Juan is. There
   * is no male Vietnamese voice to choose — not a preference, an absence — so
   * the row is here and the panel says whose voice it is, rather than leaving
   * an operator to work out why this one sounds like somebody else.
   */
  { name: 'Vietnamese', boost: 'Vietnamese' },
] as const;

export type SpokenLanguage = (typeof SPOKEN_LANGUAGES)[number]['name'];

/**
 * One sentence per language, for hearing what a voice actually sounds like.
 *
 * The panel's test bench speaks these. They are the same sentence in eighteen
 * languages rather than eighteen different sentences, because the thing being
 * compared is the mouth and not the words — and they are a real introduction
 * rather than "testing, one two three", so what an operator hears is what a
 * person on WhatsApp would hear.
 *
 * Typed as a total map over `SpokenLanguage`, deliberately: adding a language
 * above without a line here is a compile error, not a row whose Play button
 * does nothing. There is a test as well, for the same rule stated where a
 * reader will look for it.
 */
export const LANGUAGE_SAMPLES: Readonly<Record<SpokenLanguage, string>> = {
  English: "Hello, I'm Juan. I'm a helpful assistant, and this is how I sound when I speak your language.",
  Spanish: 'Hola, soy Juan. Soy un asistente útil, y así sueno cuando hablo tu idioma.',
  French: 'Bonjour, je suis Juan. Je suis un assistant utile, et voici comment je sonne quand je parle votre langue.',
  Italian: 'Ciao, sono Juan. Sono un assistente utile, ed ecco come suono quando parlo la tua lingua.',
  Portuguese: 'Olá, eu sou o Juan. Sou um assistente prestativo, e é assim que soo quando falo a sua língua.',
  Catalan: 'Hola, sóc en Juan. Sóc un assistent útil, i així sono quan parlo la teva llengua.',
  Filipino: 'Kumusta, ako si Juan. Isa akong matulunging assistant, at ganito ang tunog ko kapag nagsasalita ako ng wika mo.',
  Cebuano: 'Kumusta, ako si Juan. Usa ko ka matabangong assistant, ug mao kini ang akong tingog kung mosulti ko sa imong pinulongan.',
  Indonesian: 'Halo, saya Juan. Saya asisten yang membantu, dan beginilah suara saya saat berbicara bahasa Anda.',
  Dutch: 'Hallo, ik ben Juan. Ik ben een behulpzame assistent, en zo klink ik als ik jouw taal spreek.',
  German: 'Hallo, ich bin Juan. Ich bin ein hilfsbereiter Assistent, und so klinge ich, wenn ich deine Sprache spreche.',
  Swedish: 'Hej, jag heter Juan. Jag är en hjälpsam assistent, och så här låter jag när jag talar ditt språk.',
  Turkish: 'Merhaba, ben Juan. Yardımcı bir asistanım ve senin dilinde konuştuğumda kulağa böyle geliyorum.',
  Arabic: 'مرحبًا، أنا خوان. أنا مساعد مفيد، وهكذا أبدو عندما أتحدث لغتك.',
  Mandarin: '你好，我是胡安。我是一个乐于助人的助手，这就是我说你的语言时的声音。',
  Russian: 'Здравствуйте, меня зовут Хуан. Я полезный помощник, и вот как я звучу, когда говорю на вашем языке.',
  Japanese: 'こんにちは、フアンです。お役に立てるアシスタントです。あなたの言語で話すと、このように聞こえます。',
  Vietnamese: 'Xin chào, tôi là Juan. Tôi là một trợ lý hữu ích, và đây là giọng của tôi khi nói tiếng của bạn.',
};

/**
 * Where the provider's catalogue does not give us what the row wants.
 *
 * Two rows are compromises rather than choices, and both were established by
 * reading the live `get_voice` catalogue rather than by assuming from the
 * language's name. Written down here because the alternative is a blank field
 * and a surprising accent, neither of which explains itself:
 *
 *   · **Swedish** has a `language_boost` and not one voice. The row is worth
 *     having — the boost is what stops Swedish being read with an English
 *     mouth — but there is nothing to audition, so the panel says so instead of
 *     offering a button that spends money to play the default voice reading
 *     Swedish words.
 *   · **Vietnamese** has exactly one voice and it is female. Every other row is
 *     read by a man because that is who Juan is; this one cannot be.
 *
 * `voiceless` is the machine-readable half — the panel withholds the audition
 * control on those rows — and `note` is the half a person reads. Both travel to
 * the panel with the language list so the copy has one home.
 *
 * A third language did not make it in at all: the provider has no Punjabi voice
 * *and* no Punjabi boost, so there is nothing a row could carry. It is absent
 * rather than listed-and-broken.
 */
export const LANGUAGE_LIMITS: Readonly<
  Partial<Record<SpokenLanguage, { readonly voiceless: boolean; readonly note: string }>>
> = {
  Swedish: {
    voiceless: true,
    note: 'The provider has no Swedish voice at all. The setting above still improves how Swedish is pronounced, but whichever default voice you have set is the one that reads it — there is nothing here to audition.',
  },
  Vietnamese: {
    voiceless: false,
    note: 'The provider has exactly one Vietnamese voice and it is female. There is no male option to choose.',
  },
};

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
