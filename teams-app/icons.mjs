#!/usr/bin/env node
// Regenerates the two placeholder icons Teams requires in every app package:
//
//   color.png    192×192, full colour, opaque
//   outline.png   32×32, transparent, white glyph only
//
// Both are drawn from the same SVG so they match. Nothing here is branding —
// replace the PNGs with real artwork whenever there is some; the build script
// only checks that they exist and have the right dimensions.
//
// Uses `sharp`, which is already in the bridge's dependency tree (npm ci at the
// repository root installs it). No new dependency.
//
//   node teams-app/icons.mjs

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));

// A tulip: three petals in a cup, a stem, one leaf. Drawn in a 64-unit box.
const tulip = (fill) => `
  <path fill="${fill}" d="M18 30 C18 16 25 12 32 23 C39 12 46 16 46 30
    C46 41 40 46 32 46 C24 46 18 41 18 30 Z"/>
  <path fill="${fill}" d="M32 22 L27 34 L32 30 L37 34 Z" opacity="0.35"/>
  <rect fill="${fill}" x="30.5" y="45" width="3" height="16" rx="1.5"/>
  <path fill="${fill}" d="M32 56 C26 56 20 52 18 45 C25 45 30 49 32 56 Z"/>
`;

const color = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="12" fill="#1f5f52"/>
  ${tulip('#f4efe6')}
</svg>`;

const outline = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  ${tulip('#ffffff')}
</svg>`;

await sharp(Buffer.from(color)).resize(192, 192).png().toFile(join(here, 'color.png'));
await sharp(Buffer.from(outline)).resize(32, 32).png().toFile(join(here, 'outline.png'));

console.log('wrote teams-app/color.png (192×192) and teams-app/outline.png (32×32)');
