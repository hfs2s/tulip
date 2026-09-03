/**
 * Pre-seed Claude Code's own configuration, so an unattended session never
 * meets an onboarding screen.
 *
 * On a first launch Claude Code asks a few interactive questions — a theme, the
 * bypass-permissions acknowledgement, and whether this directory is trusted.
 * There is nobody here to answer them. Worse, they are not *errors*: the
 * process starts, stays up, looks entirely healthy, and holds the keyboard, so
 * a message typed at it is swallowed by a menu. From the outside that is
 * indistinguishable from an agent that read someone's message and decided to
 * ignore it.
 *
 * Answering the dialogs by sending keystrokes works, and `sessions.ts` keeps
 * that as a fallback, but it is guesswork against a UI that changes between
 * releases. Writing the answers into the config file first is deterministic.
 *
 * Read-modify-write, and never fatal: Claude Code writes this file itself and
 * owns keys we should not disturb (`machineID`, migration flags), so the
 * existing document is preserved and only the onboarding answers are added.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '@tulip/shared';
import { log } from './log.js';

/** Where Claude Code keeps global state, honouring CLAUDE_CONFIG_DIR. */
function configFile(): string {
  const dir = process.env['CLAUDE_CONFIG_DIR'] ?? join(process.env['HOME'] ?? '/workspace', '.claude');
  return join(dir, '.claude.json');
}

/**
 * Mark onboarding complete, and trust `projectDir`.
 *
 * Called before every spawn rather than once at startup. Claude Code rewrites
 * this file wholesale on exit, so a flag set at boot can be gone by the time a
 * later session starts — the same reason Iris re-answers the trust dialog from
 * the terminal as a backstop.
 */
export function seedClaudeConfig(projectDir: string): void {
  const file = configFile();

  let config: Record<string, unknown> = {};
  try {
    if (existsSync(file)) config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    // A corrupt config is worth replacing: the alternative is a session that
    // never starts, and nothing in this file is irreplaceable.
    log('claudeConfig.unreadable', { note: 'rewriting' });
    config = {};
  }

  const projects = (config['projects'] as Record<string, Record<string, unknown>> | undefined) ?? {};
  projects[projectDir] = {
    ...(projects[projectDir] ?? {}),
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
  };

  // Claude Code asks whether to trust an API key it finds in the environment,
  // and defaults to "No (recommended)". That default is right for a laptop and
  // wrong here: the key was put there deliberately by the compose file, and
  // there is nobody to answer. Approvals are recorded by the key's last twenty
  // characters, so only that suffix is ever written down.
  const apiKey = process.env['ANTHROPIC_API_KEY'] ?? process.env['ANTHROPIC_AUTH_TOKEN'] ?? '';
  const responses =
    (config['customApiKeyResponses'] as { approved?: string[]; rejected?: string[] } | undefined) ?? {};
  const approved = new Set(responses.approved ?? []);
  if (apiKey.length >= 20) approved.add(apiKey.slice(-20));

  const seeded: Record<string, unknown> = {
    ...config,
    customApiKeyResponses: { approved: [...approved], rejected: responses.rejected ?? [] },
    // A theme must be chosen or the picker blocks the prompt. Nobody is looking
    // at this terminal, so the value is arbitrary; having one is not.
    theme: config['theme'] ?? 'dark',
    hasCompletedOnboarding: true,
    // The agent runs with --dangerously-skip-permissions by deliberate design;
    // see docs/THREAT-MODEL.md §T1. The acknowledgement screen is asking a
    // question that was already answered in the compose file.
    bypassPermissionsModeAccepted: true,
    projects,
  };

  try {
    mkdirSync(join(file, '..'), { recursive: true });
    writeJsonAtomic(file, seeded, 0o600);
  } catch (err) {
    // Non-fatal: sessions.ts answers the dialogs from the pane if they appear.
    log('claudeConfig.seedFailed', { err: String((err as Error).message) });
  }
}
