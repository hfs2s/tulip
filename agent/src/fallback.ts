/**
 * Decide whether the Stop hook may relay terminal prose automatically.
 *
 * Group silence is normal, so a group reply must always be an explicit
 * `tulip-wa send`. The supervisor writes `fallback` only for direct-message
 * turns, while the prompt hook snapshots the turn it actually submitted into
 * `answering`. Requiring the same id in both files also makes a late hook fail
 * closed after the shared session has advanced to another conversation.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function marker(dir: string, name: string): string | null {
  try {
    const value = readFileSync(join(dir, name), 'utf8').trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function automaticFallbackTurn(markers: string): string | null {
  const answering = marker(markers, 'answering');
  if (answering === null) return null;
  return marker(markers, 'fallback') === answering ? answering : null;
}
