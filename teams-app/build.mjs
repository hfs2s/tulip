#!/usr/bin/env node
// Builds the Teams app package for one instance.
//
//   node teams-app/build.mjs instances/<handle>/.env
//   node teams-app/build.mjs .env                       # the default instance
//
// Reads the instance's .env, fills the ${...} placeholders in manifest.json,
// checks the result is a manifest Teams will accept, and writes
// teams-app/dist/<handle>.zip with manifest.json, color.png and outline.png at
// the zip root — Teams rejects a package where they sit in a subdirectory.
//
// It reads the .env only to fill the manifest. The two values it takes from it
// are the app id and the agent's name; the client secret is never read, and
// nothing secret ends up in the zip. The zip is safe to hand to whoever holds
// the admin account.
//
// No dependencies. Node has no zip writer of its own and the repository has no
// zip library, so this writes the archive itself — entries are stored rather
// than deflated (three small files; Teams accepts either) and timestamps are
// fixed, so building twice from the same inputs gives byte-identical output.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// ─── Placeholders ────────────────────────────────────────────────────────────
//
// Required from the .env: TULIP_TEAMS_APP_ID. Everything else has a default,
// and any of them can be overridden by setting the same name in the .env.
// The TULIP_TEAMS_PACKAGE_* names exist only for this script; the bridge
// never reads them.
const DEFAULTS = {
  TULIP_AGENT_NAME: 'Tulip',
  TULIP_TEAMS_PACKAGE_VERSION: '1.0.0',
  TULIP_TEAMS_PACKAGE_DEVELOPER: '2lp',
  TULIP_TEAMS_PACKAGE_WEBSITE: 'https://2lp.chat/',
  TULIP_TEAMS_PACKAGE_PRIVACY: 'https://2lp.chat/privacy',
  TULIP_TEAMS_PACKAGE_TERMS: 'https://2lp.chat/terms',
};
const REQUIRED = ['TULIP_TEAMS_APP_ID'];

function die(msg) {
  console.error(`teams-app/build: ${msg}`);
  process.exit(1);
}

// ─── .env ────────────────────────────────────────────────────────────────────
// KEY=VALUE per line; blank lines and # comments ignored; a leading `export `
// tolerated; matching surrounding quotes stripped. The last assignment wins,
// which is how compose reads it too.
function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    } else {
      v = v.replace(/\s+#.*$/, '').trim();
    }
    out[m[1]] = v;
  }
  return out;
}

// ─── Arguments ───────────────────────────────────────────────────────────────
const envArg = process.argv[2];
if (!envArg) die('usage: node teams-app/build.mjs <path to instance .env>');
const envPath = resolve(envArg);
if (!existsSync(envPath)) die(`no such file: ${envPath}`);

const env = parseEnv(readFileSync(envPath, 'utf8'));

// The handle is the instance directory's name when the .env lives under
// instances/; otherwise TULIP_INSTANCE, or "tulip" for the default instance.
const envDir = dirname(envPath);
const handle =
  basename(dirname(envDir)) === 'instances' ? basename(envDir) : env.TULIP_INSTANCE || 'tulip';

// ─── Substitution ────────────────────────────────────────────────────────────
const values = { ...DEFAULTS };
for (const [k, v] of Object.entries(env)) if (v !== '') values[k] = v;

for (const k of REQUIRED) {
  if (!values[k]) die(`${k} is not set in ${envPath}`);
}

const template = readFileSync(join(here, 'manifest.json'), 'utf8');
const missing = new Set();
const filled = template.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
  if (values[name] === undefined) {
    missing.add(name);
    return '';
  }
  // The value lands inside a JSON string literal, so escape it as one.
  return JSON.stringify(values[name]).slice(1, -1);
});
if (missing.size) die(`manifest.json uses placeholders with no value: ${[...missing].join(', ')}`);

// ─── Checks ──────────────────────────────────────────────────────────────────
// Not a schema validation — the real one is the Developer Portal's App
// validation, or the error Teams gives on upload. These are the mistakes that
// are cheap to catch here and slow to diagnose there.
let manifest;
try {
  manifest = JSON.parse(filled);
} catch (e) {
  die(`substituted manifest is not valid JSON: ${e.message}`);
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const problems = [];
const check = (cond, msg) => { if (!cond) problems.push(msg); };

check(GUID.test(manifest.id), `id is not a GUID: ${manifest.id}`);
check(GUID.test(manifest.bots?.[0]?.botId), `bots[0].botId is not a GUID`);
check(GUID.test(manifest.webApplicationInfo?.id), `webApplicationInfo.id is not a GUID`);
check(/^\d+\.\d+\.\d+$/.test(manifest.version), `version must be x.y.z: ${manifest.version}`);
check(typeof manifest.manifestVersion === 'string', 'manifestVersion missing');
check((manifest.name?.short ?? '').length > 0, 'name.short is empty');
check((manifest.name?.short ?? '').length <= 30, 'name.short is over 30 characters');
check((manifest.name?.full ?? '').length <= 100, 'name.full is over 100 characters');
check((manifest.description?.short ?? '').length <= 80, 'description.short is over 80 characters');
check((manifest.description?.full ?? '').length <= 4000, 'description.full is over 4000 characters');
check((manifest.developer?.name ?? '').length <= 32, 'developer.name is over 32 characters');
for (const k of ['websiteUrl', 'privacyUrl', 'termsOfUseUrl']) {
  check(/^https:\/\//.test(manifest.developer?.[k] ?? ''), `developer.${k} must be an https URL`);
}
check(manifest.icons?.color === 'color.png' && manifest.icons?.outline === 'outline.png',
  'icons must be color.png and outline.png at the package root');

// PNG dimensions straight from the IHDR chunk: width and height are the two
// big-endian uint32s at offsets 16 and 20 of every PNG.
function pngSize(path) {
  const b = readFileSync(path);
  if (b.length < 24 || b.toString('latin1', 1, 4) !== 'PNG') return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b };
}
const icons = {};
for (const [file, w, h] of [['color.png', 192, 192], ['outline.png', 32, 32]]) {
  const p = join(here, file);
  if (!existsSync(p)) { problems.push(`${file} is missing (run node teams-app/icons.mjs)`); continue; }
  const s = pngSize(p);
  if (!s) { problems.push(`${file} is not a PNG`); continue; }
  if (s.w !== w || s.h !== h) problems.push(`${file} is ${s.w}×${s.h}; Teams requires ${w}×${h}`);
  icons[file] = s.bytes;
}

if (problems.length) die(`refusing to build:\n  - ${problems.join('\n  - ')}`);

// ─── Zip ─────────────────────────────────────────────────────────────────────
// Minimal ZIP writer: stored entries, CRC-32, local headers, central directory,
// end-of-central-directory record. Fixed DOS timestamp (2020-01-01 00:00) so
// output is reproducible.
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const DOS_TIME = 0x0000; // 00:00:00
  const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1; // 2020-01-01
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);       // version needed
    local.writeUInt16LE(0x0800, 6);   // flags: UTF-8 names
    local.writeUInt16LE(0, 8);        // method: stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);     // version made by
    central.writeUInt16LE(20, 6);     // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);     // extra
    central.writeUInt16LE(0, 32);     // comment
    central.writeUInt16LE(0, 34);     // disk
    central.writeUInt16LE(0, 36);     // internal attrs
    central.writeUInt32LE(0, 38);     // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const centralStart = offset;
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

// ─── Output ──────────────────────────────────────────────────────────────────
const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
const distDir = join(here, 'dist');
const unpacked = join(distDir, handle);
mkdirSync(unpacked, { recursive: true });
writeFileSync(join(unpacked, 'manifest.json'), manifestBytes);
writeFileSync(join(unpacked, 'color.png'), icons['color.png']);
writeFileSync(join(unpacked, 'outline.png'), icons['outline.png']);

const zipPath = join(distDir, `${handle}.zip`);
writeFileSync(zipPath, zip([
  ['manifest.json', manifestBytes],
  ['color.png', icons['color.png']],
  ['outline.png', icons['outline.png']],
]));

console.log(`instance   ${handle}`);
console.log(`app id     ${manifest.id}`);
console.log(`name       ${manifest.name.short}  (v${manifest.version}, manifest ${manifest.manifestVersion})`);
console.log(`rsc        ${manifest.authorization.permissions.resourceSpecific.map((p) => p.name).join(', ')}`);
console.log(`package    ${zipPath}`);
console.log(`unpacked   ${unpacked}/`);
