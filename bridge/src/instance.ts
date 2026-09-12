/**
 * Which deployment this bridge is.
 *
 * One codebase runs several agents — each its own compose project, with its own
 * WhatsApp number, volumes, panel and persona — so the handful of places that
 * say the agent's name out loud cannot have one baked in. The panel, the
 * operator commands and the voice bench read it from here.
 *
 * From the environment rather than config.json, on the line README draws: the
 * name is part of what a deployment *is*, like its hostnames, and not a
 * preference an operator tunes. It is display-only. Nothing is decided from it,
 * and the persona — which is what the agent is actually told — is separate.
 */
function clean(value: string | undefined, max: number): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/** What people call the agent: "Juan", "Maria". */
export const AGENT_NAME = clean(process.env['TULIP_AGENT_NAME'], 40) ?? 'Tulip';

/** The compose project this bridge belongs to, for telling two panels apart. */
export const INSTANCE = clean(process.env['TULIP_INSTANCE'], 40) ?? 'tulip';
