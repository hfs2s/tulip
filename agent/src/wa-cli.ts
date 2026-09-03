#!/usr/bin/env node
/**
 * `tulip-wa` — the agent's voice.
 *
 * Queues an action on the outbound volume and returns immediately; the bridge
 * performs the actual send. Decoupled on purpose, so a WhatsApp hiccup can
 * never hang the agent's Bash call and so the agent never holds a socket.
 *
 * **There is no `--to`.** In Iris the equivalent command takes one, and the
 * bridge honours it, which means a prompt injection that reaches the shell can
 * forward one person's conversation to another's number. Here the destination
 * is not something this program can express: it stamps the action with the id
 * of the turn *this chat* is answering, and the bridge resolves that id through
 * a map the agent cannot write to. Cross-chat sending is not refused, it is
 * unsayable.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { OutboxAction, outPaths, writeJsonAtomic } from '@tulip/shared';
import { readTurn, workspaceFor, WORKSPACE_ROOT } from './workspace.js';

const USAGE = `usage:
  tulip-wa send <text>|-      reply to the person you are answering ("-" reads stdin)
  tulip-wa file <path> [text] send a file, with an optional caption
  tulip-wa react <emoji>      react to their most recent message
  tulip-wa typing on|off      show or clear the typing indicator
  tulip-wa whoami             which conversation you are answering

There is no way to address a different conversation. Replies go to the person
whose message you are handling, and only to them.
`;

function die(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/**
 * Which chat this process belongs to.
 *
 * The environment variable is set per tmux window when the session is spawned,
 * so it is correct even if the agent has changed directory. Walking up from the
 * working directory is the fallback for a shell started by hand.
 */
function currentWorkspace(): { dir: string; turnId: string } {
  const fromEnv = process.env['TULIP_CHAT_DIR'];
  const candidates = [fromEnv, ...ancestors(process.cwd())].filter((d): d is string => typeof d === 'string');

  for (const dir of candidates) {
    if (!existsSync(join(dir, '.turn'))) continue;
    const chatKey = basename(dir);
    const turnId = readTurn(workspaceFor(chatKey));
    if (turnId !== null) return { dir, turnId };
  }
  die('tulip-wa: no conversation is being answered right now — nothing has been routed to you yet.');
}

function ancestors(from: string): string[] {
  const out: string[] = [];
  let dir = resolve(from);
  for (let i = 0; i < 8; i++) {
    out.push(dir);
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

function queue(action: Record<string, unknown>): void {
  const id = randomUUID();
  const { dir, turnId } = currentWorkspace();
  const validated = OutboxAction.safeParse({ id, turnId, ...action });
  if (!validated.success) {
    die(`tulip-wa: ${validated.error.issues[0]?.message ?? 'invalid action'}`);
  }
  mkdirSync(outPaths.actions, { recursive: true });
  writeJsonAtomic(outPaths.action(id), validated.data, 0o644);

  // Tell the Stop hook this turn has already spoken. Without it, a turn that
  // sends a reply and then adds a closing remark in the terminal gets that
  // remark relayed as a second, duplicate message.
  if (action['kind'] !== 'typing') {
    try {
      mkdirSync(join(dir, '.markers'), { recursive: true });
      writeFileSync(join(dir, '.markers', 'spoke'), String(Date.now()));
    } catch {
      /* the duplicate is a nuisance, not a failure */
    }
  }
}

/** Extensions the bridge will accept. Checked here too, for a clearer error. */
const SENDABLE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.txt', '.md', '.csv', '.json']);

/**
 * Stage a file for sending.
 *
 * Copied into the outbound volume under a name this program chooses, rather
 * than referenced where it lies. The agent's own filenames are not trusted to
 * be path-safe, and the bridge only ever opens files from one directory.
 */
function stageFile(path: string): string {
  const source = resolve(path);
  if (!existsSync(source)) die(`tulip-wa file: ${path} does not exist`);
  if (!statSync(source).isFile()) die(`tulip-wa file: ${path} is not a file`);

  const extension = extname(source).toLowerCase();
  if (!SENDABLE.has(extension)) {
    die(`tulip-wa file: files of type "${extension || 'none'}" cannot be sent. Allowed: ${[...SENDABLE].join(' ')}`);
  }

  const name = `${randomUUID()}${extension}`;
  mkdirSync(outPaths.files, { recursive: true });
  copyFileSync(source, join(outPaths.files, name));
  return name;
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case 'send': {
    const joined = rest.join(' ');
    const text = (joined === '-' || joined === '' ? readFileSync(0, 'utf8') : joined).replace(/\s+$/, '');
    if (text.length === 0) die('tulip-wa send: nothing to send');
    // Split rather than refuse: a long answer is the agent's problem to
    // paginate, not the person's problem to never receive.
    for (let i = 0; i < text.length; i += 4000) {
      queue({ kind: 'text', text: text.slice(i, i + 4000) });
    }
    break;
  }

  case 'file': {
    const [path, ...caption] = rest;
    if (path === undefined) die('tulip-wa file: need a path');
    queue({ kind: 'file', file: stageFile(path), caption: caption.join(' ') || null });
    break;
  }

  case 'react': {
    const emoji = rest.join(' ').trim();
    if (emoji.length === 0) die('tulip-wa react: need an emoji');
    queue({ kind: 'react', emoji });
    break;
  }

  case 'typing': {
    queue({ kind: 'typing', on: rest[0] !== 'off' });
    break;
  }

  case 'whoami': {
    const { dir } = currentWorkspace();
    process.stdout.write(
      `You are answering one conversation, working in ${dir}.\n` +
        `Its identity is deliberately opaque: no phone number or name reaches this container.\n`,
    );
    break;
  }

  default:
    process.stderr.write(USAGE);
    process.exit(command === undefined ? 1 : 1);
}

export { WORKSPACE_ROOT };
