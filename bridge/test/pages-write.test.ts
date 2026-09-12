/**
 * Writing to a page's own database — the one thing a page may change on the
 * server, and every way it must refuse.
 *
 * The happy path is small. What earns the tests is the rest: a write only with
 * the page's password, only to this page's own file, only against tables and
 * columns that already exist, and never leaving the served file torn or invalid
 * if anything goes wrong.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'tulip-pages-write-'));
process.env['TULIP_STATE_DIR'] = join(root, 'state');
process.env['TULIP_IN_DIR'] = join(root, 'in');
process.env['TULIP_OUT_DIR'] = join(root, 'out');
process.env['TULIP_PAGES_HOST'] = 'pages.example.com';

const { applyPageWrite, parsePageWrite, pageWriteGate, hashPagePassword, servePageWrite } =
  await import('../src/pages.js');
const { outPaths } = await import('@2lp/shared');

const SECRET = '{"noiseKey":"the whatsapp session"}';
const PASSWORD = 'correct horse';
const AUTH = 'Basic ' + Buffer.from('anyone:' + PASSWORD).toString('base64');

/** A page with a real roster database in it, and return the db path. */
function roster(slug: string): string {
  const dir = outPaths.page(slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<script src="/_kit/sqlite.js"></script>');
  const path = join(dir, 'roster.sqlite');
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE shifts (id INTEGER PRIMARY KEY, name TEXT, status TEXT NOT NULL DEFAULT '')");
  db.prepare('INSERT INTO shifts (id, name, status) VALUES (?, ?, ?)').run(1, 'Zorblax', '');
  db.prepare('INSERT INTO shifts (id, name, status) VALUES (?, ?, ?)').run(2, 'Xylar-7', 'Confirmed');
  db.close();
  return path;
}

/** Read one column straight from the file on disk. */
function status(path: string, id: number): string | undefined {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare('SELECT status FROM shifts WHERE id = ?').get(id) as { status: string } | undefined;
    return row?.status;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  rmSync(outPaths.pages, { recursive: true, force: true });
  rmSync(join(root, 'state'), { recursive: true, force: true });
  mkdirSync(join(root, 'state', 'session'), { recursive: true });
  writeFileSync(join(root, 'state', 'session', 'creds.json'), SECRET);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('applyPageWrite', () => {
  it('updates an existing row, and the file stays a valid database', async () => {
    const path = roster('cch');
    const result = await applyPageWrite('cch', {
      db: 'roster.sqlite', table: 'shifts',
      set: [['status', "Can't make it"]], where: [['id', '1']],
    });
    expect(result.ok).toBe(true);
    expect(status(path, 1)).toBe("Can't make it");
    expect(status(path, 2)).toBe('Confirmed'); // untouched
    // A valid SQLite file, with no stray journal beside it.
    expect(readFileSync(path).subarray(0, 16).toString('latin1')).toBe('SQLite format 3\0');
    expect(() => readFileSync(path + '-journal')).toThrow();
    expect(() => readFileSync(path + '-wal')).toThrow();
  });

  it('inserts a row when no row is named', async () => {
    const path = roster('cch');
    const result = await applyPageWrite('cch', {
      db: 'roster.sqlite', table: 'shifts', set: [['name', 'Quasar Vex'], ['status', 'Confirmed']], where: [],
    });
    expect(result.ok).toBe(true);
    const db = new DatabaseSync(path, { readOnly: true });
    expect((db.prepare('SELECT count(*) c FROM shifts').get() as { c: number }).c).toBe(3);
    db.close();
  });

  it('refuses a table that does not exist, and changes nothing', async () => {
    const path = roster('cch');
    const result = await applyPageWrite('cch', { db: 'roster.sqlite', table: 'secrets', set: [['status', 'x']], where: [['id', '1']] });
    expect(result.ok).toBe(false);
    expect(status(path, 1)).toBe('');
  });

  it('refuses a column that does not exist', async () => {
    const path = roster('cch');
    const result = await applyPageWrite('cch', { db: 'roster.sqlite', table: 'shifts', set: [['evil', 'x']], where: [['id', '1']] });
    expect(result.ok).toBe(false);
    expect(status(path, 1)).toBe('');
  });

  it('treats an injection attempt as a name, which is not a real one', async () => {
    const path = roster('cch');
    for (const table of ['shifts; DROP TABLE shifts', 'shifts"--', "shifts'"]) {
      expect((await applyPageWrite('cch', { db: 'roster.sqlite', table, set: [['status', 'x']], where: [['id', '1']] })).ok).toBe(false);
    }
    for (const col of ['status = 1, name', 'status"']) {
      expect((await applyPageWrite('cch', { db: 'roster.sqlite', table: 'shifts', set: [[col, 'x']], where: [['id', '1']] })).ok).toBe(false);
    }
    // The table is still there and still has its two rows.
    const db = new DatabaseSync(path, { readOnly: true });
    expect((db.prepare('SELECT count(*) c FROM shifts').get() as { c: number }).c).toBe(2);
    db.close();
  });

  it('keeps the value a value — a string that looks like SQL is stored verbatim', async () => {
    const path = roster('cch');
    await applyPageWrite('cch', { db: 'roster.sqlite', table: 'shifts', set: [['status', "'); DROP TABLE shifts;--"]], where: [['id', '1']] });
    expect(status(path, 1)).toBe("'); DROP TABLE shifts;--");
  });

  it('refuses an over-long value and a write with nothing to set', async () => {
    roster('cch');
    expect((await applyPageWrite('cch', { db: 'roster.sqlite', table: 'shifts', set: [['status', 'x'.repeat(5000)]], where: [['id', '1']] })).ok).toBe(false);
    expect((await applyPageWrite('cch', { db: 'roster.sqlite', table: 'shifts', set: [], where: [['id', '1']] })).ok).toBe(false);
  });

  it('will not write through a symlinked page directory', async () => {
    // pages/leak -> /state/session ; a write to leak/x.db must not land in state.
    mkdirSync(outPaths.pages, { recursive: true });
    symlinkSync(join(root, 'state', 'session'), join(outPaths.pages, 'leak'));
    const result = await applyPageWrite('leak', { db: 'creds.json.db', table: 'shifts', set: [['status', 'x']], where: [] });
    expect(result.ok).toBe(false);
    expect(readFileSync(join(root, 'state', 'session', 'creds.json'), 'utf8')).toBe(SECRET);
  });

  it('refuses to write a file that is not a database', async () => {
    const dir = outPaths.page('notdb');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'data.db'), 'name,status\na,b\n');
    const result = await applyPageWrite('notdb', { db: 'data.db', table: 'shifts', set: [['status', 'x']], where: [] });
    expect(result.ok).toBe(false);
    expect(readFileSync(join(dir, 'data.db'), 'utf8')).toBe('name,status\na,b\n');
  });
});

describe('parsePageWrite', () => {
  it('splits set and where out of the bracketed form body', () => {
    const w = parsePageWrite('db=roster.sqlite&table=shifts&set%5Bstatus%5D=Confirmed&set%5Bnote%5D=hi&where%5Bid%5D=7');
    expect(w).toEqual({ db: 'roster.sqlite', table: 'shifts', set: [['status', 'Confirmed'], ['note', 'hi']], where: [['id', '7']] });
  });

  it('is null without a db or a table', () => {
    expect(parsePageWrite('table=shifts')).toBeNull();
    expect(parsePageWrite('db=roster.sqlite')).toBeNull();
  });
});

describe('pageWriteGate', () => {
  const stored = hashPagePassword(PASSWORD);
  it('refuses a page with no password at all', () => {
    expect(pageWriteGate(undefined, AUTH)).toBe('no-password');
  });
  it('refuses the wrong password and admits the right one', () => {
    expect(pageWriteGate(stored, undefined)).toBe('unauthorised');
    expect(pageWriteGate(stored, 'Basic ' + Buffer.from('a:nope').toString('base64'))).toBe('unauthorised');
    expect(pageWriteGate(stored, AUTH)).toBe('ok');
  });
});

describe('servePageWrite over HTTP', () => {
  const post = async (
    slug: string, form: string, opts: { auth?: string; json?: boolean; passwords?: Record<string, ReturnType<typeof hashPagePassword>> } = {},
  ): Promise<{ status: number; location: string | null; body: string }> => {
    const passwords = opts.passwords ?? {};
    const server = createServer((req, res) => {
      void servePageWrite(res, new URL(req.url ?? '/', 'http://pages.example.com'), req, passwords, form);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${String(port)}/${slug}/`, {
        method: 'POST', redirect: 'manual',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          ...(opts.json ? { accept: 'application/json' } : {}),
          ...(opts.auth ? { authorization: opts.auth } : {}),
        },
        body: form,
      });
      return { status: res.status, location: res.headers.get('location'), body: await res.text() };
    } finally {
      server.closeAllConnections();
      server.close();
    }
  };

  const change = 'db=roster.sqlite&table=shifts&set%5Bstatus%5D=Confirmed&where%5Bid%5D=1';

  it('refuses a page that has no password, changing nothing', async () => {
    const path = roster('cch');
    const res = await post('cch', change); // no passwords configured
    expect(res.status).toBe(403);
    expect(status(path, 1)).toBe('');
  });

  it('asks for the password when the page has one but the request lacks it', async () => {
    roster('cch');
    const res = await post('cch', change, { passwords: { cch: hashPagePassword(PASSWORD) } });
    expect(res.status).toBe(401);
    expect(res.body).toContain('password');
  });

  it('applies the change and redirects back when the password is right', async () => {
    const path = roster('cch');
    const res = await post('cch', change, { auth: AUTH, passwords: { cch: hashPagePassword(PASSWORD) } });
    expect(res.status).toBe(303);
    expect(res.location).toBe('/cch/');
    expect(status(path, 1)).toBe('Confirmed');
  });

  it('applies the change without navigation when JSON is requested', async () => {
    const path = roster('cch');
    const res = await post('cch', change, {
      auth: AUTH, json: true, passwords: { cch: hashPagePassword(PASSWORD) },
    });
    expect(res.status).toBe(200);
    expect(res.location).toBeNull();
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(status(path, 1)).toBe('Confirmed');
  });

  it('will not let one page write another, even with the first page unlocked', async () => {
    // Two pages, each its own password. A form posting to /other/ is gated by
    // other's password, not cch's — so cch's credential cannot reach it.
    const other = roster('other');
    const res = await post('other', change, { auth: AUTH, passwords: { cch: hashPagePassword(PASSWORD), other: hashPagePassword('different') } });
    expect(res.status).toBe(401);
    expect(status(other, 1)).toBe('');
  });
});
