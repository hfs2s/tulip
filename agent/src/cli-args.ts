/**
 * Lifting flags out of a `tulip-wa` command line.
 *
 * Its own module because of what `voice` does with what is left: it *speaks* it.
 * Anything this fails to lift is read aloud into a recording and sent to
 * somebody — which has happened, with a flag and a chat key, to the wrong
 * person. That makes the order and the completeness of these three functions a
 * correctness problem worth testing rather than a parsing convenience, and the
 * CLI itself cannot be imported by a test because it runs on import.
 *
 * They return a result rather than exiting, so the caller owns the process and
 * a test can see the message.
 */
import { LanguageBoost } from '@tulip/shared';

export type Lifted<T> = { ok: true; value: T; rest: string[] } | { ok: false; message: string };

/** `--to <chatKey>`, addressing another conversation. */
export function takeDestination(argv: readonly string[], verb: string): Lifted<string | null> {
  const at = argv.indexOf('--to');
  if (at === -1) return { ok: true, value: null, rest: [...argv] };
  const chatKey = argv[at + 1];
  if (chatKey === undefined || !/^[0-9a-f]{16}$/.test(chatKey)) {
    return { ok: false, message: `tulip-wa ${verb} --to: need a 16-character chat key, from \`tulip-wa chats\`` };
  }
  return { ok: true, value: chatKey, rest: [...argv.slice(0, at), ...argv.slice(at + 2)] };
}

/**
 * `--language <name>`, the accent a voice note is read with.
 *
 * Validated here rather than at the provider: a name MiniMax does not know
 * fails the entire synthesis request, and the voice note then arrives as text
 * with nothing saying why. Dying at the keyboard with the list in hand is a
 * mistake the agent can read and correct within the same turn.
 */
export function takeLanguage(argv: readonly string[], verb: string): Lifted<string> {
  const at = argv.indexOf('--language');
  if (at === -1) return { ok: true, value: '', rest: [...argv] };
  const language = argv[at + 1];
  if (language === undefined || language === '' || !LanguageBoost.safeParse(language).success) {
    return {
      ok: false,
      message:
        `tulip-wa ${verb} --language: "${language ?? ''}" is not one the provider knows. ` +
        'Spelling is exact and capitalised: English, Spanish, Catalan, Filipino, auto' +
        " — or leave the flag off to use the operator's setting.",
    };
  }
  return { ok: true, value: language, rest: [...argv.slice(0, at), ...argv.slice(at + 2)] };
}

/**
 * Refuse an unrecognised `--flag` rather than treating it as content.
 *
 * Runs after everything above has been lifted, and is the backstop for the
 * whole family: whatever reaches it is about to be sent or spoken as written.
 */
export function strayFlag(argv: readonly string[], verb: string): string | null {
  const stray = argv.find((a) => a.startsWith('--'));
  return stray === undefined
    ? null
    : `tulip-wa ${verb}: ${stray} is not an option, and it would have been sent as content`;
}
