#!/usr/bin/env node
/**
 * Vendor the panel's third-party assets next to the compiled bridge.
 *
 * The panel serves its own fonts and its own shader bundle rather than pulling
 * them from a CDN, and that is a security decision rather than a preference:
 * the page renders message text written by strangers, so its CSP says
 * `script-src 'self'` and `font-src 'self'`. A CDN would mean relaxing exactly
 * the directive that is doing the work.
 *
 * Everything here is optional at run time. `panel.ts` serves these files if
 * they exist and degrades quietly if they do not, so a development tree without
 * a build still renders — in system fonts, with no backdrop.
 *
 * Run automatically by `npm run build` in the bridge workspace.
 */
import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'bridge', 'dist');
const fonts = join(out, 'fonts');

mkdirSync(fonts, { recursive: true });

/** Resolve a file inside an installed package, or null if it is not there. */
function fromPackage(specifier) {
  try {
    return require.resolve(specifier, { paths: [root] });
  } catch {
    return null;
  }
}

let vendored = 0;

// ── Fonts ────────────────────────────────────────────────────────────────────
// Latin subsets only. The panel is an operator console in one language, and the
// full set would multiply the payload for glyphs nobody here will render.
for (const [specifier, name] of [
  ['@fontsource-variable/onest/files/onest-latin-wght-normal.woff2', 'onest.woff2'],
  ['@fontsource-variable/inter/files/inter-latin-wght-normal.woff2', 'inter.woff2'],
]) {
  const source = fromPackage(specifier);
  if (!source) {
    console.warn(`  ! ${name}: not installed, skipping`);
    continue;
  }
  cpSync(source, join(fonts, name));
  console.log(`  ✓ ${name} (${statSync(join(fonts, name)).size} bytes)`);
  vendored += 1;
}

// Redistributing OFL fonts requires the licence to travel with them.
const licence = fromPackage('@fontsource-variable/onest/LICENSE');
if (licence) cpSync(licence, join(fonts, 'LICENSE.txt'));

// ── Shader bundle ────────────────────────────────────────────────────────────
// Bundled to a single IIFE exposing one global, because ESM from a directory of
// modules would mean serving the whole package tree.
const shaders = fromPackage('@paper-design/shaders');
if (!shaders) {
  console.warn('  ! shaders.js: @paper-design/shaders is not installed, skipping');
} else {
  try {
    const esbuild = await import('esbuild');
    await esbuild.build({
      entryPoints: [shaders],
      bundle: true,
      format: 'iife',
      globalName: 'PaperShaders',
      minify: true,
      target: 'es2020',
      outfile: join(out, 'shaders.js'),
      logLevel: 'silent',
    });
    console.log(`  ✓ shaders.js (${statSync(join(out, 'shaders.js')).size} bytes)`);
    vendored += 1;
  } catch (err) {
    // A backdrop is never worth failing a build over.
    console.warn(`  ! shaders.js: ${err.message}`);
    writeFileSync(join(out, 'shaders.js'), '/* shader bundle unavailable at build time */\n');
  }
}

console.log(`panel assets: ${vendored} vendored into ${out}`);
if (!existsSync(join(fonts, 'onest.woff2'))) {
  console.log('  (the panel falls back to system fonts when these are absent)');
}
