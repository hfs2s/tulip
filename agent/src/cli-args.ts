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
import { resolveLanguage } from '@tulip/shared';

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
/**
 * The mouth a voice note is read with. **Required**, and worth saying why.
 *
 * It used to be optional, falling back to one setting for the whole
 * deployment — which is wrong for somebody the moment two conversations are in
 * two languages, and silently so: the audio arrives, it just sounds foreign.
 * The agent is the only thing that knows which language it has just written in,
 * so it is the thing that has to say.
 *
 * Automatic detection is not the answer either. It hears Filipino and Cebuano
 * as Malay or Indonesian — close enough to be plausible, wrong enough to be
 * heard — so `auto` is available but is a choice rather than a default.
 *
 * Near-names are accepted and translated: the agent reaches for the language it
 * was writing, and "Bisaya" or "Valencian" are not values the provider knows.
 * See `LANGUAGE_ALIASES` for what that costs.
 */
export function takeLanguage(argv: readonly string[], verb: string): Lifted<string> {
  const at = argv.indexOf('--language');
  if (at === -1) {
    return {
      ok: false,
      message:
        `tulip-wa ${verb}: --language is required. Say which language you wrote in — ` +
        'automatic detection hears Filipino and Bisaya as Malay, so nobody can guess it for you. ' +
        `Run \`tulip-wa languages\` for the list. Example: tulip-wa ${verb} --language Filipino "…"`,
    };
  }
  const typed = argv[at + 1];
  const resolved = typed === undefined ? null : resolveLanguage(typed);
  if (resolved === null) {
    return {
      ok: false,
      message:
        `tulip-wa ${verb} --language: "${typed ?? ''}" is not one the provider knows, ` +
        'and there is no near-name for it either. `tulip-wa languages` lists every value ' +
        'and the names that map onto one.',
    };
  }
  return { ok: true, value: resolved, rest: [...argv.slice(0, at), ...argv.slice(at + 2)] };
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
