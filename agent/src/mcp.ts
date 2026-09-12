#!/usr/bin/env node
/**
 * The `tulip` MCP server — stdio, started by Claude Code for each chat session.
 *
 * It is a child of that `claude` process, so it inherits `TULIP_CHAT_DIR` from
 * the tmux window the supervisor spawned, and so does every `tulip-wa` it runs.
 * That binding is what the CLI refuses without, which is why a session nobody
 * routed a conversation to still cannot send through here.
 *
 * Nothing but JSON-RPC may reach stdout: it is the protocol channel. The CLI's
 * own output is captured and returned as the tool result.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { handle, type Runner } from './mcp-tools.js';

const CLI = fileURLToPath(new URL('./wa-cli.js', import.meta.url));

/**
 * Longer than the slowest verb: `page-image` waits up to 120s on the bridge.
 * A tool may ask for more — `plugin` does, because it waits on a service whose
 * timeout the operator sets — and gets exactly what it asks for.
 */
const CALL_TIMEOUT_MS = 150_000;

const run: Runner = (argv, stdin, timeoutMs = CALL_TIMEOUT_MS) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...argv], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, out: `could not run tulip-wa: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out });
    });
    // Always closed, even with nothing to write: a verb that falls back to
    // reading stdin must see an empty stream, not wait on one forever.
    child.stdin.end(stdin ?? '');
  });

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/**
 * Calls still running. Exiting the moment stdin closes would drop their
 * answers — and a `send` whose answer is dropped has usually still been
 * queued, so the model would be told it failed when it did not.
 */
let pending = 0;
let closed = false;
const settle = (): void => {
  if (closed && pending === 0) process.exit(0);
};

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (line.trim().length === 0) return;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  pending += 1;
  void handle(message, run)
    .then((response) => {
      if (response !== null) write(response);
    })
    .catch((err: unknown) => {
      process.stderr.write(`tulip mcp: ${String((err as Error).message)}\n`);
    })
    .finally(() => {
      pending -= 1;
      settle();
    });
});
lines.on('close', () => {
  closed = true;
  settle();
});
