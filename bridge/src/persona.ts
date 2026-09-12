/**
 * The persona, as an operator setting.
 *
 * It used to be four version-controlled files baked into both images, and the
 * panel only displayed them — deliberately, because an editor whose saves take
 * effect "at some unrelated moment" promises something it cannot deliver. Two
 * changes make an editor honest:
 *
 *   - **The saved copy lives here**, in the bridge's own config directory, and
 *     is published to the inbound volume with a version. The agent mounts that
 *     read-only, so it cannot rewrite who it has been told to be.
 *   - **The agent compares that version before every turn** and resumes its
 *     session under a fresh brief when it changed. A save reaches the very next
 *     message, and the conversation is kept.
 *
 * What ships in `persona/` is now a *starter*: what a part says until an
 * operator saves their own, and what Revert goes back to. A deployment's own
 * character never has to be committed anywhere, which matters for a public
 * repository.
 *
 * Every save and revert keeps the text it replaced in `.history/`. This took
 * over from git as the record of what the agent was told, so it keeps one.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  BRIEF_LIMIT_CHARS,
  PART_MAX_CHARS,
  PERSONA_PARTS,
  type PersonaPart,
  composePersona,
  inPaths,
  isPersonaPart,
  personaVersion,
  writeFileAtomic,
  writeJsonAtomic,
} from '@2lp/shared';
import { log } from './log.js';

const STORE = process.env['TULIP_PERSONA_STORE'] ?? '/config/persona';
const STARTER = process.env['TULIP_PERSONA_DOCS'] ?? '/persona';
const HISTORY = join(STORE, '.history');
/** Per part. Twenty edits back is more than anybody scrolls, and it stays small. */
const HISTORY_KEEP = 20;

export interface PersonaPartView {
  readonly name: PersonaPart;
  readonly text: string;
  /** Where `text` came from. `missing` means neither a save nor a starter exists. */
  readonly source: 'saved' | 'starter' | 'missing';
  /** The shipped starter, for Revert and for showing what a save differs from. */
  readonly starter: string | null;
}

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Each part as the agent will receive it: the operator's save, else the starter. */
export function readPersona(): PersonaPartView[] {
  return PERSONA_PARTS.map((name) => {
    const saved = readOrNull(join(STORE, name));
    const starter = readOrNull(join(STARTER, name));
    if (saved !== null) return { name, text: saved, source: 'saved', starter };
    if (starter !== null) return { name, text: starter, source: 'starter', starter };
    return { name, text: '', source: 'missing', starter: null };
  });
}

const present = (p: PersonaPartView): p is PersonaPartView & { source: 'saved' | 'starter' } => p.source !== 'missing';

/** Everything the panel shows: the parts, how big the brief is, and the version live. */
export function personaView(): {
  parts: Array<PersonaPartView & { chars: number }>;
  briefChars: number;
  limit: number;
  partMax: number;
  version: string;
} {
  const parts = readPersona();
  const composed = composePersona(parts.filter(present));
  return {
    parts: parts.map((p) => ({ ...p, chars: p.text.length })),
    briefChars: composed.length,
    limit: BRIEF_LIMIT_CHARS,
    partMax: PART_MAX_CHARS,
    version: personaVersion(composed),
  };
}

/**
 * Hand the agent the persona as it stands. Returns the version, or null if the
 * write failed.
 *
 * Called at every start and after every change. A failure leaves the previous
 * file in place — the write is atomic — and the agent keeps the brief it has
 * rather than falling back to the starter, so a bad moment here costs an edit
 * its effect, never the deployment its character.
 */
export function publishPersona(): string | null {
  const parts = readPersona().filter(present);
  const composed = composePersona(parts);
  const version = personaVersion(composed);
  try {
    writeJsonAtomic(
      inPaths.persona,
      { version, at: new Date().toISOString(), parts: parts.map(({ name, text, source }) => ({ name, text, source })) },
      0o644,
    );
    log('persona.published', {
      version,
      chars: composed.length,
      saved: parts.filter((p) => p.source === 'saved').map((p) => p.name),
    });
    return version;
  } catch (err) {
    log('persona.publishFailed', { err: String((err as Error).message) });
    return null;
  }
}

/** Keep what a part said before it changes, and let the oldest copies go. */
function archive(name: PersonaPart): void {
  const current = join(STORE, name);
  if (!existsSync(current)) return;
  mkdirSync(HISTORY, { recursive: true });
  const stem = name.replace(/\.md$/, '');
  copyFileSync(current, join(HISTORY, `${stem}.${new Date().toISOString().replace(/[:.]/g, '-')}.md`));
  const kept = readdirSync(HISTORY)
    .filter((f) => f.startsWith(`${stem}.`))
    .sort();
  for (const old of kept.slice(0, Math.max(0, kept.length - HISTORY_KEEP))) rmSync(join(HISTORY, old), { force: true });
}

export type PersonaSaved =
  | { ok: true; version: string | null; briefChars: number; overLimit: boolean }
  | { ok: false; error: string };

/**
 * Save one part. An empty part is allowed and leaves that section out of the
 * brief; going back to the starter is Revert, which is a different thing.
 */
export function savePersonaPart(name: string, text: string): PersonaSaved {
  if (!isPersonaPart(name)) return { ok: false, error: `There is no persona part called ${name}.` };
  const body = text.replace(/\r\n/g, '\n');
  if (body.length > PART_MAX_CHARS) {
    return {
      ok: false,
      error: `${name} is ${String(body.length)} characters and one part may be ${String(PART_MAX_CHARS)}. Nothing was saved.`,
    };
  }
  if (readOrNull(join(STORE, name)) !== body) {
    mkdirSync(STORE, { recursive: true });
    archive(name);
    writeFileAtomic(join(STORE, name), body, 0o600);
    log('persona.saved', { part: name, chars: body.length });
  }
  const version = publishPersona();
  const { briefChars } = personaView();
  return { ok: true, version, briefChars, overLimit: briefChars > BRIEF_LIMIT_CHARS };
}

/** Drop a saved part so it follows the starter again. The saved text goes to history. */
export function revertPersonaPart(name: string): PersonaSaved {
  if (!isPersonaPart(name)) return { ok: false, error: `There is no persona part called ${name}.` };
  if (existsSync(join(STORE, name))) {
    archive(name);
    rmSync(join(STORE, name), { force: true });
    log('persona.reverted', { part: name });
  }
  const version = publishPersona();
  const { briefChars } = personaView();
  return { ok: true, version, briefChars, overLimit: briefChars > BRIEF_LIMIT_CHARS };
}
