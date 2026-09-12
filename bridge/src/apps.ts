/**
 * The apps on the hfs2s box, and which conversations may work on them.
 *
 * A page and an app are not the same kind of thing, and this file exists
 * because treating them alike would be a lie. The bridge *serves* pages: it
 * owns the files, so a grant on one is enforced by the process doing the work,
 * and a password on one is checked before a byte leaves. An hfs2s app is a
 * workspace on another machine, reached over a restricted ssh gate through the
 * `hfs2s` plugin — this deployment cannot take one down, lock it or delete it,
 * and offering switches that pretend otherwise would be worse than offering
 * none: a switch that is believed is a switch that gets relied on.
 *
 * So there is one control here, and it is the one that belongs to this side:
 * **who may ask**. `apps.grants` says which conversations may have the agent
 * run the plugin's workspace actions — `health`, `errors`, `snapshots`,
 * `exec` — against a given workspace. That decision happens in the bridge,
 * before anything is written into the plugin's drop-box, which is why it is
 * worth something.
 *
 * An app nobody has been granted reaches nobody but an operator. There is no
 * standing rule that opens the unclaimed ones, deliberately — see `Apps` in
 * config.ts for why pages have one and these do not.
 *
 * The listing is the plugin's `status`, parsed. It is fixed-width text from the
 * gate rather than JSON, so `parseStatus` is forgiving in what it accepts and
 * strict about what it keeps: a line it cannot read becomes no workspace, never
 * a half-read one. A workspace the panel does not know about is simply not
 * grantable, which is the safe direction — `mayUse` refuses on the grant map,
 * not on the listing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { writeJsonAtomic } from '@2lp/shared';
import type { Config } from './config.js';
import { identities, matchesList } from './jid.js';
import { log } from './log.js';
import { paths } from './paths.js';
import { askPluginText } from './pluginCalls.js';

/**
 * The plugin this page is about, and the argument that names a workspace.
 *
 * Named here rather than discovered: the grant is only meaningful because we
 * know what `workspace` means to this plugin, and a plugin that happened to
 * take an argument of the same name would not be the hfs2s box.
 */
export const APPS_PLUGIN = 'hfs2s';
export const WORKSPACE_ARG = 'workspace';

/** Eight hex characters, as the box prints them and as config.ts keys them. */
export const WORKSPACE_ID = /^[0-9a-f]{8}$/;

export interface Workspace {
  readonly id: string;
  /** The box's name for it, or null where it prints `(unnamed)`. */
  readonly name: string | null;
  /** What we call it here, when somebody has said. Overrides `name` on sight. */
  readonly label?: string | null;
  /** `ready`, `sleeping`, `working` — the box's word, shown as given. */
  readonly state: string;
  /** True where the box says `you`: the operator's own, rather than a client's. */
  readonly mine: boolean;
  /** The box's `handed-over` flag, which it prints for an app given to its owner. */
  readonly handedOver: boolean;
  /** Every address it answers on, the canonical one first. */
  readonly addresses: readonly string[];
}

/**
 * One row of `status`.
 *
 * The columns are separated by two or more spaces, which is what lets a name
 * with single spaces in it — "Juan More Chance LA" — stay one field. The
 * trailing flag is optional and the address list is whatever remains.
 */
const ROW = /^([0-9a-f]{8})\s\s+(.+?)\s\s+(\S+)\s\s+(you|client)(\s+handed-over)?\s\s+(.+?)\s*$/;

export function parseStatus(text: string): Workspace[] {
  const out: Workspace[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const row = ROW.exec(line);
    if (row === null) continue;
    const [, id, rawName, state, owner, handed, addresses] = row;
    if (id === undefined || state === undefined || addresses === undefined) continue;
    // Two rows under one id would make a grant ambiguous and put two switches
    // on the page that fight. First one wins, deterministically.
    if (seen.has(id)) continue;
    seen.add(id);
    const name = (rawName ?? '').trim();
    out.push({
      id,
      name: name === '(unnamed)' || name.length === 0 ? null : name.slice(0, 120),
      state: state.slice(0, 32),
      mine: owner === 'you',
      handedOver: handed !== undefined,
      addresses: addresses
        .split(',')
        .map((a) => a.trim())
        .filter((a) => a.length > 0 && a.length < 200)
        .slice(0, 12),
    });
  }
  return out;
}


/**
 * What we call each app, when the box's own name is missing or wrong.
 *
 * Twenty-two of the thirty-two workspaces come back `(unnamed)`, and the agent
 * cannot rename one on the box: the gate offers `status`, `health`, `errors`,
 * `snapshots` and `exec`, and nothing that touches the control plane. So a
 * label is ours, kept here, and shown wherever the app is named.
 *
 * The agent asks and the bridge writes, exactly as for `remember`. See
 * `paths.appLabels` for why this is state rather than config.
 */
const LabelFile = z.record(z.string().regex(WORKSPACE_ID), z.object({
  label: z.string().min(1).max(60),
  at: z.number(),
  /** The chat that named it, so "who called it that" has an answer. */
  chatKey: z.string().max(64).nullable(),
}).strict());
export type AppLabel = z.infer<typeof LabelFile>[string];

/** At most one per workspace, and the box holds a few dozen. */
const MAX_LABELS = 400;

export function readLabels(): Record<string, AppLabel> {
  try {
    if (!existsSync(paths.appLabels)) return {};
    const parsed = LabelFile.safeParse(JSON.parse(readFileSync(paths.appLabels, 'utf8')));
    return parsed.success ? parsed.data : {};
  } catch {
    // A label is decoration. A corrupt file costs the names, never the page.
    return {};
  }
}

/**
 * Name one app, or clear its name.
 *
 * Returns what the panel and the agent should say, rather than throwing: the
 * caller is answering somebody who asked for this in a sentence.
 */
export function setLabel(id: string, label: string | null, chatKey: string | null): { ok: boolean; error?: string } {
  if (!WORKSPACE_ID.test(id)) return { ok: false, error: 'that is not a workspace id — they are eight characters, from the apps listing' };
  const trimmed = (label ?? '').trim().replace(/\s+/g, ' ');
  if (trimmed.length > 60) return { ok: false, error: 'a label is at most 60 characters' };

  const labels = readLabels();
  if (trimmed.length === 0) {
    delete labels[id];
  } else {
    if (!Object.hasOwn(labels, id) && Object.keys(labels).length >= MAX_LABELS) {
      return { ok: false, error: 'there are too many labels already — an operator can clear some from the panel' };
    }
    labels[id] = { label: trimmed, at: Date.now(), chatKey };
  }
  try {
    writeJsonAtomic(paths.appLabels, labels, 0o600);
  } catch (err) {
    log('apps.labelWriteFailed', { workspace: id, err: String((err as Error).message).slice(0, 200) });
    return { ok: false, error: 'the label could not be written. Tell an operator.' };
  }
  log('apps.labelled', { workspace: id, cleared: trimmed.length === 0 });
  // The listing is cached for a minute and now says the wrong name.
  forgetApps();
  return { ok: true };
}

/** The name to show: ours first, then the box's, then the id. */
export function displayName(app: Workspace): string {
  return app.label ?? app.name ?? app.id;
}

/** How long a listing is reused before the box is asked again. */
const TTL_MS = 60_000;

export interface Listing {
  readonly apps: readonly Workspace[];
  /** When this was actually fetched, or null if it never has been. */
  readonly at: number | null;
  /** Why the last attempt failed, if it did. The panel shows it verbatim. */
  readonly error: string | null;
}

let cached: Listing = { apps: [], at: null, error: null };
let inflight: Promise<Listing> | null = null;

/** For tests, and for a panel that wants the next read to be a real one. */
export function forgetApps(): void {
  cached = { apps: [], at: null, error: null };
  inflight = null;
}

export interface ListDeps {
  readonly config: Config;
  readonly pluginsDir?: string | undefined;
  readonly ask?: typeof askPluginText;
}

/**
 * Ask the box what it is hosting.
 *
 * Every answer costs an ssh round trip to another machine, so it is cached for
 * a minute and concurrent callers share one flight — the panel polls, and three
 * operators with the page open must not be three connections.
 *
 * Never throws, and never leaves the panel with nothing: a failed call keeps
 * the last good listing and reports the failure beside it. An operator looking
 * at an empty page cannot tell "you have no apps" from "the box did not
 * answer", and those call for opposite actions.
 *
 * Called as the operator. The panel is behind Access and a bearer token, and
 * this plugin is `operatorOnly`; a listing that refused the panel would make
 * the page permanently empty.
 */
export async function listApps(deps: ListDeps, now = Date.now()): Promise<Listing> {
  if (cached.at !== null && now - cached.at < TTL_MS) return cached;
  if (inflight !== null) return inflight;

  const ask = deps.ask ?? askPluginText;
  inflight = (async (): Promise<Listing> => {
    try {
      const answer = await ask({
        config: deps.config,
        plugin: APPS_PLUGIN,
        action: 'status',
        args: {},
        fromOperator: true,
        ...(deps.pluginsDir === undefined ? {} : { root: deps.pluginsDir }),
      });
      if (!answer.ok) {
        log('apps.listFailed', { note: answer.error.slice(0, 200) });
        cached = { apps: cached.apps, at: cached.at, error: answer.error };
        return cached;
      }
      const labels = readLabels();
      cached = {
        apps: parseStatus(answer.text).map((app) => ({ ...app, label: labels[app.id]?.label ?? null })),
        at: now,
        error: null,
      };
      return cached;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Look an id up in a config map without asking the prototype.
 *
 * The sibling of `own` in pages.ts, and there for the same reason: an id
 * reaches here from the agent, on behalf of whoever it is talking to, and a
 * plain object answers `map['constructor']` with a function rather than
 * `undefined` — which is then called as `granted.includes(...)` and throws out
 * of the outbox handler. `WORKSPACE_ID` does not match `constructor`, so this
 * is belt and braces; the belt is one line and the failure is loud.
 */
function own<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/**
 * May this conversation have the agent work on this workspace?
 *
 * `mayChange`'s sibling for apps, with two differences stated in config.ts: an
 * operator is never refused, and nothing else is allowed unless it was granted
 * by name. There is no `open` to fall through to.
 */
export function mayUse(
  config: Config,
  id: string,
  chatKey: string,
  chat: { readonly jid: string; readonly altJid: string | null; readonly isGroup: boolean } | null,
  fromOperator: boolean,
): boolean {
  if (fromOperator) return true;
  const granted = own(config.apps.grants, id);
  // Ungranted is nobody. Unlike a page, an app has no standing rule that could
  // say otherwise, so an absent grant and an empty one are the same answer.
  if (granted === undefined) return false;
  if (granted.includes(chatKey)) return true;

  // Granted by phone number or linked id — the only way to hand an app to
  // somebody who has never written. Direct chats only: a group's jid is the
  // group's, not a member's, so a number could otherwise authorise a room.
  if (chat === null || chat.isGroup) return false;
  return matchesList({ jids: granted }, identities(chat.jid, chat.altJid));
}

/**
 * Why a refusal when the call is about the box rather than about one app.
 *
 * `status` lists every workspace on the machine — other people's included —
 * and `box` reports its disk and memory. Neither names a workspace, so neither
 * can be governed by a grant, and an operator switching `operatorOnly` off so
 * that a client's group can work on that client's app would otherwise hand
 * every conversation the whole inventory. That is not what granting one app
 * means, so these two stay the operator's.
 */
export const NOT_THE_BOX =
  'that asks about the hosting box as a whole rather than about one app, and only an operator can — in a direct message';

/** Why a refusal, worded for the agent, which is the only reader. */
export const NOT_YOUR_APP =
  'that app is not this conversation’s to work on — the operator grants an app to the people whose app it is';
