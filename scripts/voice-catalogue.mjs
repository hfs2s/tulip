#!/usr/bin/env node
/**
 * Which languages this deployment could actually speak.
 *
 * Read-only, and run by hand. It asks MiniMax for its live voice catalogue and
 * prints it against the two lists in `shared/src/languages.ts`, so the answer to
 * "what else could we support" is measured rather than guessed.
 *
 * **Guessing is what this exists to stop.** Every gap in that file was found by
 * reading the catalogue and every one of them contradicted the language's name:
 * Swedish has a `language_boost` and no voice at all, Vietnamese had exactly one
 * and it was female, Punjabi has neither. A row added from the boost list alone
 * is a control in the panel that produces a voice note in somebody else's
 * accent — which is the failure the `UNSPOKEN_BOOSTS` list now catches, and
 * which nobody should be adding more of on purpose.
 *
 * **Run it on the box, not here.** `MINIMAX_API_KEY` is a billed credential
 * that lives in the Pi's `.env` and deliberately nowhere else — never in the
 * agent container, never in this repository. This script reads it from the
 * environment and sends it to one host.
 *
 *     ssh <pi> 'cd <tulip> && set -a && . ./.env && set +a && node scripts/voice-catalogue.mjs'
 *
 * Or, without a checkout on the box, inside the bridge container, which already
 * has the key and the file:
 *
 *     docker compose exec bridge node scripts/voice-catalogue.mjs
 *
 * It writes nothing and changes nothing. Adding a language is still a
 * deliberate edit to `SPOKEN_LANGUAGES` plus a sample sentence, after somebody
 * has actually listened to the voice in the panel's test bench.
 */
import { LANGUAGE_BOOSTS, SPOKEN_LANGUAGES, UNSPOKEN_BOOSTS } from '../shared/dist/languages.js';

const key = (process.env.MINIMAX_API_KEY ?? '').trim();
const base = (process.env.MINIMAX_BASE_URL ?? '').trim() || 'https://api.minimax.io';
const group = (process.env.MINIMAX_GROUP_ID ?? '').trim();

if (key.length === 0) {
  console.error(
    'No MINIMAX_API_KEY in the environment.\n' +
      'This is meant to be run where the key already lives — on the Pi, or inside the bridge container.\n' +
      'See the header of this file.',
  );
  process.exit(1);
}

/**
 * The catalogue endpoint has moved before, so try the shapes rather than
 * assuming one and reporting "no voices" when the answer was a 404.
 */
const ATTEMPTS = [
  { path: '/v1/get_voice', body: { voice_type: 'all' } },
  { path: '/v1/get_voice', body: {} },
];

async function catalogue() {
  const failures = [];
  for (const attempt of ATTEMPTS) {
    const url = `${base}${attempt.path}${group ? `?GroupId=${encodeURIComponent(group)}` : ''}`;
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(attempt.body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      failures.push(`${attempt.path}: ${String(err.message)}`);
      continue;
    }
    const text = await response.text();
    if (!response.ok) {
      failures.push(`${attempt.path}: HTTP ${response.status} ${text.slice(0, 200)}`);
      continue;
    }
    try {
      return { ok: true, data: JSON.parse(text) };
    } catch {
      failures.push(`${attempt.path}: answered with something that is not JSON`);
    }
  }
  return { ok: false, failures };
}

/** Every voice in the response, whatever key the provider filed it under. */
function flatten(data) {
  const out = [];
  for (const [group, value] of Object.entries(data ?? {})) {
    if (!Array.isArray(value)) continue;
    for (const voice of value) {
      if (typeof voice !== 'object' || voice === null) continue;
      out.push({
        group,
        id: String(voice.voice_id ?? voice.id ?? ''),
        name: String(voice.voice_name ?? voice.name ?? ''),
        // Not every entry carries these; they are printed when present because
        // "one voice, and it is female" is exactly the kind of fact that decides
        // whether a row is worth having.
        gender: voice.gender === undefined ? '' : String(voice.gender),
        blob: JSON.stringify(voice).toLowerCase(),
      });
    }
  }
  return out;
}

const result = await catalogue();
if (!result.ok) {
  console.error('Could not read the catalogue:\n  ' + result.failures.join('\n  '));
  process.exit(1);
}

const voices = flatten(result.data);
console.log(`${voices.length} voices in the catalogue at ${base}\n`);

const rows = new Set(SPOKEN_LANGUAGES.map((r) => r.boost));
const withheld = new Set(UNSPOKEN_BOOSTS);

/**
 * Match a language to voices by name, which is a heuristic and is labelled as
 * one. The provider names voices things like `Spanish_ReliableNarrator`, so
 * this finds most of them — but a miss here is a reason to look at the raw
 * dump, not a reason to conclude there is no voice.
 */
const matches = (language) => {
  const needle = language.toLowerCase().split(',')[0];
  return voices.filter((v) => v.blob.includes(needle));
};

const candidates = [];
for (const boost of LANGUAGE_BOOSTS) {
  if (boost === 'auto') continue;
  const found = matches(boost);
  const state = rows.has(boost) ? 'row' : withheld.has(boost) ? 'withheld' : 'none';
  if (state === 'none' && found.length > 0) candidates.push({ boost, found });
  const label = state === 'row' ? '  ' : state === 'withheld' ? '✗ ' : '  ';
  console.log(
    `${label}${boost.padEnd(14)} ${String(found.length).padStart(3)} voice(s)` +
      `${state === 'row' ? '   [has a row]' : state === 'withheld' ? '   [withheld]' : ''}`,
  );
}

console.log('\n── Could be added ──────────────────────────────────────────');
if (candidates.length === 0) {
  console.log('Nothing new: every boost with a voice already has a row or was withdrawn.');
} else {
  for (const c of candidates) {
    const sample = c.found.slice(0, 4).map((v) => `${v.name || v.id}${v.gender ? ` (${v.gender})` : ''}`);
    console.log(`  ${c.boost.padEnd(14)} ${sample.join(', ')}${c.found.length > 4 ? ', …' : ''}`);
  }
  console.log(
    '\nBefore adding any of these: play it in the panel’s voice bench first. Every row\n' +
      'is read by a man because that is who Juan is, and a language whose only voice is\n' +
      'female belongs in UNSPOKEN_BOOSTS rather than in SPOKEN_LANGUAGES.',
  );
}
