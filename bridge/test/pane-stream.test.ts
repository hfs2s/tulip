/**
 * The terminal's byte stream, from the bridge's side.
 *
 * The panel's terminal used to poll a text snapshot of the pane, which is why
 * it never looked like the session: a TUI is a stream of cursor movements, and
 * a summary of one, sampled twice a second, is a different thing. The agent now
 * appends the pane's own bytes to a file and this tails it.
 *
 * Everything below is about the one case a tail has to get right — the file
 * getting *shorter*. The agent truncates whenever it repaints, so a file now
 * smaller than the offset we hold is a new stream rather than a gap in an old
 * one, and a reader that resumed at its old offset would splice the tail of one
 * screen onto the head of the next, mid-escape-sequence.
 */
import { mkdtempSync, rmSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { paneReader } from '../src/panel-api.js';

let roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratchPane(): string {
  const root = mkdtempSync(join(tmpdir(), 'tulip-pane-'));
  roots.push(root);
  return join(root, 'pane.raw');
}

describe('paneReader — following a file that only grows', () => {
  it('returns nothing when the agent has not started streaming', () => {
    const read = paneReader(scratchPane());
    expect(read()).toEqual({ reset: false, bytes: Buffer.alloc(0) });
  });

  it('returns everything on the first read, then only what is new', () => {
    const file = scratchPane();
    const read = paneReader(file);

    writeFileSync(file, 'hello');
    expect(read().bytes.toString()).toBe('hello');

    appendFileSync(file, ' world');
    expect(read().bytes.toString()).toBe(' world');
  });

  it('returns nothing when the file has not moved', () => {
    const file = scratchPane();
    const read = paneReader(file);
    writeFileSync(file, 'hello');
    read();

    const second = read();
    expect(second.bytes).toHaveLength(0);
    expect(second.reset).toBe(false);
  });

  it('carries bytes through unchanged, escape sequences included', () => {
    const file = scratchPane();
    const read = paneReader(file);
    // The point of the stream: this is what makes a terminal a terminal, and
    // exactly what the old stripped-text snapshot threw away.
    const frame = Buffer.from('[2J[H[32m● done[0m\r\n', 'utf8');
    writeFileSync(file, frame);
    expect(read().bytes.equals(frame)).toBe(true);
  });
});

describe('paneReader — the file getting shorter', () => {
  it('reports a reset and starts again from the top', () => {
    const file = scratchPane();
    const read = paneReader(file);

    writeFileSync(file, 'a long first screen');
    read();

    // What the agent does when it repaints: truncate, then seed.
    writeFileSync(file, 'new');
    const after = read();
    expect(after.reset).toBe(true);
    expect(after.bytes.toString()).toBe('new');
  });

  it('does not report a reset when the file merely grows past a repaint', () => {
    const file = scratchPane();
    const read = paneReader(file);
    writeFileSync(file, 'one');
    read();
    appendFileSync(file, 'two');
    expect(read().reset).toBe(false);
  });

  it('treats a file that disappears as a stream to be restarted', () => {
    const file = scratchPane();
    const read = paneReader(file);
    writeFileSync(file, 'gone in a moment');
    read();

    unlinkSync(file);
    expect(read()).toEqual({ reset: false, bytes: Buffer.alloc(0) });

    // Re-created: the offset must have gone back to zero with the file, or the
    // first screen of the new stream is silently skipped.
    writeFileSync(file, 'back');
    expect(read().bytes.toString()).toBe('back');
  });

  it('survives a truncation to exactly nothing', () => {
    const file = scratchPane();
    const read = paneReader(file);
    writeFileSync(file, 'something');
    read();

    writeFileSync(file, '');
    const empty = read();
    expect(empty.reset).toBe(true);
    expect(empty.bytes).toHaveLength(0);

    writeFileSync(file, 'x');
    expect(read().bytes.toString()).toBe('x');
  });
});

describe('paneReader — catching up', () => {
  it('caps one read and returns the rest on the next', () => {
    const file = scratchPane();
    const read = paneReader(file);
    // Larger than the 256 KiB chunk, which is what stops a viewer that has been
    // away from blocking the event loop on a single read.
    const big = Buffer.alloc(300 * 1024, 0x61);
    writeFileSync(file, big);

    const first = read();
    expect(first.bytes.length).toBe(256 * 1024);
    const second = read();
    expect(second.bytes.length).toBe(300 * 1024 - 256 * 1024);
    expect(read().bytes).toHaveLength(0);
  });

  it('gives each viewer its own position in the file', () => {
    const file = scratchPane();
    writeFileSync(file, 'first');

    const alice = paneReader(file);
    expect(alice().bytes.toString()).toBe('first');

    // Bob arrives late and must still be painted the screen as it stands,
    // rather than resuming at Alice's offset and seeing nothing.
    const bob = paneReader(file);
    expect(bob().bytes.toString()).toBe('first');

    appendFileSync(file, '-second');
    expect(alice().bytes.toString()).toBe('-second');
    expect(bob().bytes.toString()).toBe('-second');
  });
});
