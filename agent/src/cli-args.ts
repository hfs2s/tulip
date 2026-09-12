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
import {
  PLUGIN_ACTION,
  PLUGIN_ARG_NAME,
  PLUGIN_MAX_ARGS,
  PLUGIN_MAX_ARG_CHARS,
  PLUGIN_NAME,
  resolveLanguage,
} from '@2lp/shared';

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
 * `-n <k>`, which of your own recent messages to correct.
 *
 * A flag rather than a leading bare number, and that is not fussiness: `edit 5
 * more minutes` has two honest readings — amend message five to "more minutes",
 * or amend the last one to "5 more minutes" — and the wrong one silently edits
 * the wrong message to the wrong words. A flag has one reading. Defaults to 1,
 * the thing just said, which is the case that actually comes up.
 */
export function takePosition(argv: readonly string[], verb: string): Lifted<number> {
  const at = argv.indexOf('-n');
  if (at === -1) return { ok: true, value: 1, rest: [...argv] };
  const raw = argv[at + 1];
  const n = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 20) {
    return {
      ok: false,
      message:
        `tulip-wa ${verb} -n: need a whole number from 1 to 20, counting back through what you ` +
        'have said here. 1 is your most recent. `tulip-wa sent` lists them.',
    };
  }
  return { ok: true, value: n, rest: [...argv.slice(0, at), ...argv.slice(at + 2)] };
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

/** The longest goodbye the bridge will accept; see `leaveGroup` in handoff.ts. */
export const MAX_GOODBYE = 1000;

/**
 * Why a goodbye cannot be sent as written, or null if it can.
 *
 * Refused rather than cut, for the reason `remember` refuses: it is the last
 * thing Juan says in that room, and he will not be there to correct it.
 */
export function goodbyeProblem(text: string): string | null {
  if (text.trim().length === 0) {
    return 'tulip-wa leave --goodbye: the goodbye is empty. Give the words, or leave the flag off — nothing was done.';
  }
  if (text.length > MAX_GOODBYE) {
    return (
      `tulip-wa leave --goodbye: that is ${String(text.length)} characters and the limit is ${String(MAX_GOODBYE)}. ` +
      'Write it shorter — nothing was done.'
    );
  }
  return null;
}

/**
 * `leave [<group key>] [--goodbye "…"]`.
 *
 * Nothing on this line is spoken except the goodbye, but that goes to a whole
 * group as the last thing Juan says there. So words that slipped outside the
 * quotes are refused rather than dropped or sent, and an unknown flag is
 * refused by name. `--goodbye -` means stdin — kept as `-` here for the caller
 * to read — which is how the MCP tool passes free text without it ever being
 * parsed for flags.
 */
export function takeLeave(argv: readonly string[]): Lifted<{ chatKey: string | null; goodbye: string | null }> {
  let goodbye: string | null = null;
  let rest = [...argv];
  const at = argv.indexOf('--goodbye');
  if (at !== -1) {
    const value = argv[at + 1];
    if (value === undefined || value.startsWith('--')) {
      return {
        ok: false,
        message: 'tulip-wa leave --goodbye: need the words to say, in quotes — or leave the flag off to go without one',
      };
    }
    if (argv.indexOf('--goodbye', at + 1) !== -1) {
      return { ok: false, message: 'tulip-wa leave: one --goodbye only' };
    }
    if (value !== '-') {
      const problem = goodbyeProblem(value);
      if (problem !== null) return { ok: false, message: problem };
    }
    goodbye = value === '-' ? '-' : value.trim();
    rest = [...argv.slice(0, at), ...argv.slice(at + 2)];
  }

  const stray = rest.find((a) => a.startsWith('-'));
  if (stray !== undefined) {
    return { ok: false, message: `tulip-wa leave: ${stray} is not an option. The only one is --goodbye "…".` };
  }
  if (rest.length > 1) {
    return {
      ok: false,
      message: 'tulip-wa leave: one group key at most — put the whole goodbye in quotes after --goodbye. Nothing was done.',
    };
  }
  const chatKey = rest[0] ?? null;
  if (chatKey !== null && !/^[0-9a-f]{16}$/.test(chatKey)) {
    // With a goodbye already given, a stray word is far likelier to be the end
    // of that goodbye outside its quotes than a mistyped key, so say that.
    return {
      ok: false,
      message:
        `tulip-wa leave: "${chatKey}" is not a chat key. Give the group's 16-character key from \`tulip-wa chats\`, ` +
        'or none for the group you are answering.' +
        (goodbye === null ? '' : ' If it is part of the goodbye, put the whole goodbye in quotes.') +
        ' Nothing was done.',
    };
  }
  return { ok: true, value: { chatKey, goodbye }, rest: [] };
}

/**
 * `fetch <url> [--look]`.
 *
 * Nothing here is spoken, so the stakes are lower than `voice`'s — but a flag
 * that is not recognised is still refused by name rather than ignored, because
 * `--screenshot` silently doing nothing would be read as "no picture came
 * back" and the agent would tell somebody their page could not be captured.
 * One URL, and it must be a web address: the bridge checks again, and this is
 * only here so the mistake is explained where it was made.
 */
export function takeFetch(argv: readonly string[]): Lifted<{ url: string; look: boolean }> {
  const look = argv.includes('--look');
  const rest = argv.filter((a) => a !== '--look');
  const stray = rest.find((a) => a.startsWith('-'));
  if (stray !== undefined) {
    return { ok: false, message: `tulip-wa fetch: ${stray} is not an option. The only one is --look, for a screenshot.` };
  }
  const url = rest[0];
  if (url === undefined) return { ok: false, message: 'tulip-wa fetch: need a URL' };
  if (rest.length > 1) {
    return { ok: false, message: 'tulip-wa fetch: one URL at a time — quote it if it contains spaces or &' };
  }
  if (!/^https?:\/\//i.test(url)) return { ok: false, message: 'tulip-wa fetch: only http and https URLs' };
  return { ok: true, value: { url, look }, rest: [] };
}

export interface CallLine {
  readonly plugin: string;
  readonly action: string;
  readonly args: Record<string, string>;
  /** `--args-json`'s value, still unparsed — `-` means stdin, for the caller to read. */
  readonly argsJson: string | null;
}

const USAGE_CALL = 'tulip-wa call <plugin> <action> [--arg name=value …] — names come from `tulip-wa plugins`';

/**
 * `call <plugin> <action> [--arg name=value …] [--args-json <json>|-]`.
 *
 * Nothing on this line is spoken, but it *does* something on the operator's own
 * systems, so every word is accounted for: exactly two names, each argument
 * behind its own `--arg`, and anything else refused by name rather than dropped.
 * A value is taken whole after the first `=`, so it may contain `=`, spaces or a
 * leading dash. `--args-json -` reads a JSON object from stdin instead, which is
 * how the MCP tool passes arbitrary values without any of them being parsed as
 * part of a command line at all.
 */
export function takeCall(argv: readonly string[]): Lifted<CallLine> {
  const fail = (message: string): Lifted<CallLine> => ({ ok: false, message: `${message} Nothing was asked.` });
  const positional: string[] = [];
  // A Map, not an object: `constructor` is a valid argument name, and an
  // object literal already "has" one.
  const args = new Map<string, string>();
  let argsJson: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] as string;
    if (word === '--arg') {
      const pair = argv[i + 1];
      const eq = pair === undefined ? -1 : pair.indexOf('=');
      const name = pair === undefined || eq === -1 ? '' : pair.slice(0, eq);
      if (pair === undefined || !PLUGIN_ARG_NAME.test(name)) {
        return fail(
          `tulip-wa call --arg: need name=value, where the name is a letter then letters, digits or _` +
            (pair === undefined ? '.' : ` — "${pair.slice(0, 60)}" is not that.`),
        );
      }
      if (args.has(name)) return fail(`tulip-wa call: --arg ${name} is given twice.`);
      const value = (pair as string).slice(eq + 1);
      if (value.length > PLUGIN_MAX_ARG_CHARS) {
        return fail(`tulip-wa call --arg ${name}: ${String(value.length)} characters, and the limit is ${String(PLUGIN_MAX_ARG_CHARS)}.`);
      }
      args.set(name, value);
      i += 1;
      continue;
    }
    if (word === '--args-json') {
      const value = argv[i + 1];
      if (value === undefined) return fail('tulip-wa call --args-json: need a JSON object, or - to read one from stdin.');
      if (argsJson !== null) return fail('tulip-wa call: one --args-json only.');
      argsJson = value;
      i += 1;
      continue;
    }
    if (word.startsWith('-')) {
      return fail(`tulip-wa call: ${word} is not an option. The options are --arg name=value (repeated) and --args-json.`);
    }
    positional.push(word);
  }

  if (argsJson !== null && args.size > 0) return fail('tulip-wa call: use --arg or --args-json, not both.');
  if (positional.length !== 2) return fail(`${USAGE_CALL}.`);
  const [plugin, action] = positional as [string, string];
  if (!PLUGIN_NAME.test(plugin)) return fail(`tulip-wa call: "${plugin.slice(0, 60)}" is not a plugin name. ${USAGE_CALL}.`);
  if (!PLUGIN_ACTION.test(action)) return fail(`tulip-wa call: "${action.slice(0, 60)}" is not an action name. ${USAGE_CALL}.`);
  if (args.size > PLUGIN_MAX_ARGS) return fail(`tulip-wa call: at most ${String(PLUGIN_MAX_ARGS)} arguments.`);
  return { ok: true, value: { plugin, action, args: Object.fromEntries(args), argsJson }, rest: [] };
}

/**
 * The arguments to a call, given as one JSON object of names to strings.
 *
 * Strings only, and refused rather than coerced: `{"guests": 4}` becoming "4"
 * is harmless, but `{"guests": [4]}` becoming "4" is a different request, and
 * the plugin would have no way to know it had been asked something else.
 */
export function parseCallArgs(text: string): Lifted<Record<string, string>> {
  const fail = (message: string): Lifted<Record<string, string>> => ({
    ok: false,
    message: `tulip-wa call --args-json: ${message} Nothing was asked.`,
  });
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail('that is not JSON. Give an object of names to strings, like {"ref":"4411"}.');
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return fail('give an object of names to strings, like {"ref":"4411"}.');
  }
  const entries = Object.entries(json as Record<string, unknown>);
  if (entries.length > PLUGIN_MAX_ARGS) return fail(`at most ${String(PLUGIN_MAX_ARGS)} arguments.`);
  for (const [name, value] of entries) {
    if (!PLUGIN_ARG_NAME.test(name)) return fail(`"${name.slice(0, 60)}" is not an argument name: a letter, then letters, digits or _.`);
    if (typeof value !== 'string') return fail(`${name} must be a string — quote it.`);
    if (value.length > PLUGIN_MAX_ARG_CHARS) {
      return fail(`${name} is ${String(value.length)} characters, and the limit is ${String(PLUGIN_MAX_ARG_CHARS)}.`);
    }
  }
  return { ok: true, value: Object.fromEntries(entries) as Record<string, string>, rest: [] };
}
