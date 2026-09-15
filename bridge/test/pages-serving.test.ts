/**
 * What the pages host sends, over real HTTP — and what it refuses to.
 *
 * Two things live here. A page's database reaches the page as a script, since a
 * page served `connect-src 'none'` can load nothing else; these pin that the
 * bytes arrive intact, that nothing the agent writes can stand in for them, and
 * that the policy which makes a page inert did not move to let them in.
 *
 * And every file is opened without following links, because the directory is
 * the agent's and the process reading it holds the WhatsApp session. Before
 * that, `ln -s /state/session/creds.json pages/x/creds.json` published it.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'tulip-pages-serve-'));
process.env['TULIP_STATE_DIR'] = join(root, 'state');
process.env['TULIP_IN_DIR'] = join(root, 'in');
process.env['TULIP_OUT_DIR'] = join(root, 'out');
process.env['TULIP_PAGES_HOST'] = 'pages.example.com';

const { servePage, hashPagePassword, databaseNotes, parseRange } = await import('../src/pages.js');
const { outPaths } = await import('@2lp/shared');

/** Stands in for the WhatsApp session, which lives beside the pages' volume. */
const SECRET = '{"noiseKey":"the whatsapp session"}';
const HEADER = Buffer.from('SQLite format 3\0', 'latin1');

function build(slug: string, files: Record<string, string | Buffer>): string {
  const dir = outPaths.page(slug);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

/** A database's worth of bytes: the right header, then noise, at any length. */
function database(size: number): Buffer {
  return Buffer.concat([HEADER, randomBytes(size - HEADER.length)]);
}

interface Reply {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Buffer;
}

async function get(
  path: string,
  init: { auth?: string; range?: string; passwords?: Record<string, { salt: string; hash: string }> } = {},
): Promise<Reply> {
  const server = createServer((req, res) => {
    servePage(res, new URL(req.url ?? '/', 'http://pages.example.com'), req, init.passwords ?? {});
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
      headers: {
        ...(init.auth === undefined ? {} : { authorization: init.auth }),
        ...(init.range === undefined ? {} : { range: init.range }),
      },
    });
    return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

/** Run a database script the way a browser would, and return what it defined. */
function delivered(script: Buffer): Record<string, string> {
  const self: { __tulipSqlite?: Record<string, string> } = {};
  runInNewContext(script.toString('utf8'), { self });
  return self.__tulipSqlite ?? {};
}

beforeEach(() => {
  rmSync(outPaths.pages, { recursive: true, force: true });
  rmSync(join(root, 'state'), { recursive: true, force: true });
  mkdirSync(join(root, 'state', 'session'), { recursive: true });
  writeFileSync(join(root, 'state', 'session', 'creds.json'), SECRET);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('the policy a page runs under', () => {
  it('still has no way out, now that it can compile WebAssembly', async () => {
    build('party-plan', { 'index.html': '<h1>hi</h1>' });
    const reply = await get('/party-plan/');
    expect(reply.status).toBe(200);
    const directives = (reply.headers.get('content-security-policy') ?? '').split(/\s*;\s*/);
    // connect-src stays shut: a page still cannot fetch or open a socket.
    expect(directives).toContain("connect-src 'none'");
    // form-action is the one door open, and only to the page's own host — that
    // is how a write gets back without letting a page read another's bytes.
    expect(directives).toContain("form-action 'self'");
    expect(directives).toContain("frame-ancestors 'none'");
    const script = directives.find((d) => d.startsWith('script-src '))?.split(/\s+/) ?? [];
    expect(script).toContain("'wasm-unsafe-eval'");
    // The token that would let a string become code is still not there.
    expect(script).not.toContain("'unsafe-eval'");
  });

  it('is the same policy on a database script, so a worker started from one answers to it too', async () => {
    build('party-plan', { 'index.html': 'x', 'data.sqlite': database(100) });
    const page = await get('/party-plan/');
    const data = await get('/party-plan/data.sqlite.js');
    expect(data.headers.get('content-security-policy')).toBe(page.headers.get('content-security-policy'));
  });
});

describe('a page’s database, as a script', () => {
  it('carries the file’s bytes exactly, across read boundaries', async () => {
    // Odd, and well past one 64 KB read, so base64 groups straddle chunks.
    const bytes = database(200_003);
    build('inventory', { 'index.html': 'x', 'data.sqlite': bytes });
    const reply = await get('/inventory/data.sqlite.js');
    expect(reply.status).toBe(200);
    expect(reply.headers.get('content-type')).toContain('text/javascript');
    expect(Number(reply.headers.get('content-length'))).toBe(reply.body.length);
    expect(Buffer.from(delivered(reply.body)['data.sqlite'] ?? '', 'base64').equals(bytes)).toBe(true);
  });

  it('answers for each name the kit accepts', async () => {
    build('inventory', { 'index.html': 'x', 'a.sqlite3': database(40), 'b.db': database(41) });
    expect(Object.keys(delivered((await get('/inventory/a.sqlite3.js')).body))).toEqual(['a.sqlite3']);
    expect(Object.keys(delivered((await get('/inventory/b.db.js')).body))).toEqual(['b.db']);
  });

  it('hands over an empty file as an empty database', async () => {
    build('inventory', { 'index.html': 'x', 'blank.db': '' });
    const reply = await get('/inventory/blank.db.js');
    expect(reply.status).toBe(200);
    expect(Number(reply.headers.get('content-length'))).toBe(reply.body.length);
    expect(delivered(reply.body)).toEqual({ 'blank.db': '' });
  });

  it('never serves a file the agent named to look like one', async () => {
    build('inventory', {
      'index.html': 'x',
      'data.sqlite': database(64),
      'data.sqlite.js': 'alert("not the database")',
    });
    const reply = await get('/inventory/data.sqlite.js');
    expect(reply.body.toString()).not.toContain('alert');
    expect(Object.keys(delivered(reply.body))).toEqual(['data.sqlite']);
  });

  it('answers 404 for a database that is not there', async () => {
    build('inventory', { 'index.html': 'x' });
    expect((await get('/inventory/data.sqlite.js')).status).toBe(404);
  });

  it('refuses one larger than a whole page may be', async () => {
    const dir = build('inventory', { 'index.html': 'x', 'data.sqlite': database(64) });
    truncateSync(join(dir, 'data.sqlite'), 257 * 1024 * 1024); // sparse: one byte over the 256 MB cap costs no disk
    expect((await get('/inventory/data.sqlite.js')).status).toBe(413);
  });

  it('asks for the page’s password first, like every other file of it', async () => {
    build('members', { 'index.html': 'x', 'data.sqlite': database(64) });
    const passwords = { members: hashPagePassword('correct horse') };
    expect((await get('/members/data.sqlite.js', { passwords })).status).toBe(401);
    const auth = 'Basic ' + Buffer.from('anyone:correct horse').toString('base64');
    expect((await get('/members/data.sqlite.js', { passwords, auth })).status).toBe(200);
  });

  it('serves the file itself too, for a page that offers it as a download', async () => {
    const bytes = database(1000);
    build('inventory', { 'index.html': 'x', 'data.sqlite': bytes });
    const reply = await get('/inventory/data.sqlite');
    expect(reply.headers.get('content-type')).toBe('application/vnd.sqlite3');
    expect(reply.body.equals(bytes)).toBe(true);
  });
});

describe('links the agent plants', () => {
  it('does not follow a linked file', async () => {
    const dir = build('leak', { 'index.html': 'x' });
    symlinkSync(join(root, 'state', 'session', 'creds.json'), join(dir, 'creds.json'));
    const reply = await get('/leak/creds.json');
    expect(reply.status).toBe(404);
    expect(reply.body.toString()).not.toContain('whatsapp');
  });

  it('does not follow a linked database, as a script or as itself', async () => {
    const dir = build('leak', { 'index.html': 'x' });
    symlinkSync(join(root, 'state', 'session', 'creds.json'), join(dir, 'data.sqlite'));
    const encoded = Buffer.from(SECRET).toString('base64').slice(0, 16);
    for (const path of ['/leak/data.sqlite.js', '/leak/data.sqlite']) {
      const reply = await get(path);
      expect(reply.status, path).toBe(404);
      expect(reply.body.toString(), path).not.toContain('whatsapp');
      expect(reply.body.toString(), path).not.toContain(encoded);
    }
  });

  it('does not follow a linked page directory', async () => {
    mkdirSync(outPaths.pages, { recursive: true });
    symlinkSync(join(root, 'state', 'session'), join(outPaths.pages, 'leak'));
    const reply = await get('/leak/creds.json');
    expect(reply.status).toBe(404);
    expect(reply.body.toString()).not.toContain('whatsapp');
  });

  it('does not follow the pages directory itself, swapped for a link', async () => {
    // Everything a name check could see is in order here: /leak/creds.json is a
    // real file inside a real directory, under a directory called `pages`.
    mkdirSync(join(root, 'state', 'decoy', 'leak'), { recursive: true });
    writeFileSync(join(root, 'state', 'decoy', 'leak', 'creds.json'), SECRET);
    mkdirSync(join(root, 'out'), { recursive: true });
    symlinkSync(join(root, 'state', 'decoy'), outPaths.pages);
    const reply = await get('/leak/creds.json');
    expect(reply.status).toBe(404);
    expect(reply.body.toString()).not.toContain('whatsapp');
  });

  it.skipIf(process.platform !== 'linux')('does not hang on a FIFO', async () => {
    // Opened blocking, this would stall the one event loop that also serves
    // the panel, until something wrote to the pipe — which is the agent's call.
    const dir = build('stuck', { 'index.html': 'x' });
    execFileSync('mkfifo', [join(dir, 'data.json')]);
    expect((await get('/stuck/data.json')).status).toBe(404);
  });
});

describe('the kit', () => {
  it('offers sqlite.js beside kit.css and kit.js, and nothing else', async () => {
    // Unbuilt in a test tree, so a known name answers "not built" and anything
    // else "no such file" — the allowlist, observed from outside.
    for (const known of ['kit.css', 'kit.js', 'sqlite.js']) {
      expect((await get(`/_kit/${known}`)).body.toString(), known).not.toBe('no such file\n');
    }
    for (const unknown of ['nope.js', 'constructor', '..%2Fpages.js']) {
      expect((await get(`/_kit/${unknown}`)).body.toString(), unknown).toBe('no such file\n');
    }
  });
});

describe('what publishing says about a page’s databases', () => {
  const loads = '<script src="/_kit/sqlite.js"></script>';

  it('says nothing when the page can read them', () => {
    build('fine', { 'index.html': loads, 'data.sqlite': database(4096) });
    expect(databaseNotes('fine')).toEqual([]);
  });

  it('says nothing about a page with no database', () => {
    build('plain', { 'index.html': '<h1>hi</h1>' });
    expect(databaseNotes('plain')).toEqual([]);
  });

  it('counts the kit loaded from any page of the site, not only the index', () => {
    build('multi', { 'index.html': '<a href="list.html">list</a>', 'list.html': loads, 'data.sqlite': database(64) });
    expect(databaseNotes('multi')).toEqual([]);
  });

  it('says when nothing loads the kit that reads them', () => {
    build('unread', { 'index.html': '<h1>hi</h1>', 'data.sqlite': database(64) });
    expect(databaseNotes('unread').join()).toContain('/_kit/sqlite.js');
  });

  it('says when a file is not a database at all', () => {
    build('wrong', { 'index.html': loads, 'data.db': 'name,price\nsoup,3\n' });
    expect(databaseNotes('wrong').join()).toContain('data.db is not a SQLite database');
  });

  it('says when changes are still in the write-ahead log', () => {
    build('walled', { 'index.html': loads, 'data.sqlite': database(64), 'data.sqlite-wal': 'pending' });
    expect(databaseNotes('walled').join()).toContain('wal_checkpoint');
  });

  it('lets an empty write-ahead log pass, which is what a closed database leaves', () => {
    build('closed', { 'index.html': loads, 'data.sqlite': database(64), 'data.sqlite-wal': '' });
    expect(databaseNotes('closed')).toEqual([]);
  });

  it('says when a write was left half-done', () => {
    build('torn', { 'index.html': loads, 'data.sqlite': database(64), 'data.sqlite-journal': 'x' });
    expect(databaseNotes('torn').join()).toContain('mid-write');
  });

  it('says when a database is a link, which will never be served', () => {
    const dir = build('linked', { 'index.html': loads });
    symlinkSync(join(root, 'state', 'session', 'creds.json'), join(dir, 'data.sqlite'));
    expect(databaseNotes('linked').join()).toContain('not a link');
  });
});

describe('documents and media a page carries whole', () => {
  it('serves a PDF and an m4a with their own types, and says ranges are accepted', async () => {
    build('digest', { 'index.html': 'x', 'briefing.pdf': Buffer.from('%PDF-1.4 fake'), 'episode.m4a': Buffer.alloc(100, 7) });
    const pdf = await get('/digest/briefing.pdf');
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(pdf.headers.get('accept-ranges')).toBe('bytes');
    const audio = await get('/digest/episode.m4a');
    expect(audio.status).toBe(200);
    expect(audio.headers.get('content-type')).toBe('audio/mp4');
    expect(audio.body.length).toBe(100);
  });

  it('answers one byte range with 206 and exactly those bytes', async () => {
    const bytes = Buffer.from(Array.from({ length: 50 }, (_, i) => i));
    build('digest', { 'index.html': 'x', 'episode.m4a': bytes });
    const part = await get('/digest/episode.m4a', { range: 'bytes=10-19' });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 10-19/50');
    expect(part.headers.get('content-length')).toBe('10');
    expect([...part.body]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    const tail = await get('/digest/episode.m4a', { range: 'bytes=45-' });
    expect(tail.status).toBe(206);
    expect([...tail.body]).toEqual([45, 46, 47, 48, 49]);
  });

  it('refuses a range that starts past the end, and serves whole what it does not understand', async () => {
    build('digest', { 'index.html': 'x', 'episode.m4a': Buffer.alloc(20, 1) });
    const past = await get('/digest/episode.m4a', { range: 'bytes=20-30' });
    expect(past.status).toBe(416);
    expect(past.headers.get('content-range')).toBe('bytes */20');
    const odd = await get('/digest/episode.m4a', { range: 'bytes=0-5,10-15' });
    expect(odd.status).toBe(200);
    expect(odd.body.length).toBe(20);
  });

  it('parses ranges the way browsers send them', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=0-999', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=5-3', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-', 0)).toBeNull();
  });
});
