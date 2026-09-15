/**
 * The bridge's single-instance lock.
 *
 * One file, `bridge.lock` in the state directory, holding the pid of the bridge
 * that owns this deployment. It exists for two reasons that happen to agree.
 *
 * The first is WhatsApp's: two Baileys clients on one auth store log the device
 * out and force a QR re-scan, so a second bridge starting against the same
 * state volume must refuse. Teams has no such failure — two bridges would just
 * both answer — but "two bridges on one state volume" is still a deployment
 * mistake, and refusing is still the honest response.
 *
 * The second is the container's health check, which is nothing more than "does
 * the lock exist". That made a Teams bridge report unhealthy forever, because
 * the lock used to live inside the WhatsApp transport and only WhatsApp took
 * it. Every transport takes it now, from here, before it starts listening.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './log.js';
import { paths } from './paths.js';

const LOCK_FILE = join(paths.root, 'bridge.lock');

/** Take the lock or throw. `resource` names what a second bridge would fight over. */
export function acquireBridgeLock(resource: string): void {
  if (existsSync(LOCK_FILE)) {
    const pid = Number(readFileSync(LOCK_FILE, 'utf8').trim());
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive) {
      throw new Error(`another bridge (pid ${pid}) holds ${resource}. Refusing to start.`);
    }
    log('lock.stale', { pid });
  }
  writeFileSync(LOCK_FILE, String(process.pid), { mode: 0o600 });

  const release = (): void => {
    try {
      if (readFileSync(LOCK_FILE, 'utf8').trim() === String(process.pid)) unlinkSync(LOCK_FILE);
    } catch {
      /* already released */
    }
  };
  process.on('exit', release);
}
