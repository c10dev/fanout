import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

/** Identifies this process in target leases: host, pid and a random suffix. */
export const PROCESS_OWNER = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

/**
 * A lease held by a process on this machine that no longer exists can be taken over at once. That
 * includes an earlier run with our own pid (a restarted container where node is always pid 1).
 */
export function isStaleOwner(holder: string): boolean {
  const [host, pidText] = holder.split(':');
  const pid = Number(pidText);
  if (host !== hostname() || !Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return holder !== PROCESS_OWNER;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
