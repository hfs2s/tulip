#!/usr/bin/env node
/**
 * Refuse to let a secret reach a public commit.
 *
 * This repository is public, and its ancestor was not: Iris commits real phone
 * numbers in `config.json` and was perfectly comfortable doing so, because
 * nobody outside the household could read it. That habit does not survive
 * publication, and "remember not to do that" is not a control.
 *
 * So this runs in `npm run verify` and in CI, and fails on two things:
 *
 *   1. A file that `.gitignore` names as secret-bearing is nonetheless tracked.
 *      Being gitignored does not protect a file that was added before the rule.
 *   2. A tracked file contains something shaped like a credential or a real
 *      phone number.
 *
 * Exit code 1 fails the build. There is no allow-listing flag on purpose: if a
 * finding is a false positive, change the text so it is obviously a placeholder.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

/** Files that must never be tracked, matching the secret section of .gitignore. */
const FORBIDDEN_PATHS = [
  /^\.env$/,
  /^\.env\.(?!example$)/,
  /(^|\/)config\.json$/,
  /(^|\/)config\.local\.json$/,
  /(^|\/)allow\.json$/,
  /(^|\/)blocklist\.json$/,
  /\.(key|pem)$/,
];

/**
 * Credential shapes. Each is anchored on a vendor prefix rather than on entropy,
 * because entropy heuristics on a codebase full of hex constants are noise.
 */
const SECRET_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{16,}/, 'Anthropic API key'],
  [/\bsk-[A-Za-z0-9]{32,}\b/, 'OpenAI-style API key'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, 'GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
  [/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/, 'private key'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'Slack token'],
];

/**
 * A real phone number, in the shape WhatsApp uses: bare international digits.
 *
 * Deliberately narrow. It looks only where numbers would actually be committed
 * by accident — configuration and prose — and it accepts documentation numbers,
 * because a threat model that cannot show an example is a worse document.
 */
const PHONE_PATTERN = /\b(?:\+?)([1-9]\d{9,14})\b/g;
const PHONE_SCANNED = /\.(json|md|ts|js|mjs|yml|yaml|env\.example)$/;
/** Reserved ranges and obvious dummies: fine to publish. */
const PHONE_ALLOWED = [
  /^1555\d{6,9}$/, //  +1 555 …  — North American fiction range, and near-miss variants of it
  /^44700900\d{3,}$/, // UK Ofcom drama range
  /^(\d)\1+$/, //  1111111111 — repeated digit placeholder
  /^1234567890\d*$/,
];

function tracked() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
}

const findings = [];

for (const file of tracked()) {
  for (const rule of FORBIDDEN_PATHS) {
    if (rule.test(file)) {
      findings.push(`${file}: tracked, but names a secret-bearing file (${rule})`);
    }
  }

  // Skip anything large or binary; credentials live in text.
  let body;
  try {
    if (statSync(file).size > 2_000_000) continue;
    body = readFileSync(file, 'utf8');
  } catch {
    continue; // unreadable or binary — nothing to scan
  }
  if (body.indexOf(String.fromCharCode(0)) !== -1) continue; // binary
  const lines = body.split('\n');
  lines.forEach((line, i) => {
    for (const [pattern, label] of SECRET_PATTERNS) {
      if (pattern.test(line)) findings.push(`${file}:${i + 1}: looks like a ${label}`);
    }

    if (!PHONE_SCANNED.test(file)) return;
    // This file necessarily contains the patterns it searches for.
    if (file.endsWith('scripts/check-secrets.mjs')) return;
    for (const m of line.matchAll(PHONE_PATTERN)) {
      const digits = m[1];
      if (PHONE_ALLOWED.some((ok) => ok.test(digits))) continue;
      findings.push(`${file}:${i + 1}: looks like a real phone number (${digits.slice(0, 4)}…)`);
    }
  });
}

if (findings.length) {
  console.error('✗ secret check failed\n');
  for (const f of findings) console.error(`  ${f}`);
  console.error(
    `\n${findings.length} finding(s). This repository is public: remove the value, rotate it if it was ever real, ` +
      `and use a placeholder instead.`,
  );
  process.exit(1);
}

console.log(`✓ secret check clean (${tracked().length} tracked files)`);
