import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isTerminal } from './state.ts';
import type { Store } from './store.ts';

const DAY = 86_400_000;
/** Fresh dashboard uploads may still be waiting for their post form to be submitted. */
const ORPHAN_GRACE_MS = DAY;

export interface PruneItem {
  path: string;
  bytes: number;
  reason: 'orphan_upload' | 'posted_original' | 'old_variant';
}

export interface PruneOptions {
  /** Keep originals of finished posts and transcode variants for this many days. */
  days: number;
  now: Date;
}

function files(dir: string): Array<{ path: string; bytes: number; mtimeMs: number }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const st = statSync(path);
    return st.isFile() ? [{ path, bytes: st.size, mtimeMs: st.mtimeMs }] : [];
  });
}

/**
 * What can go from `<home>/media` (dashboard uploads) and `<home>/variants` (transcode cache).
 * Only ever looks inside fanout's own home: watch-folder `posted/` files belong to the user.
 *
 * - media (videos, thumbnails, captions) not referenced by any post, older than a day → abandoned upload
 * - media of a post whose every target finished successfully, older than `days` → no retry can need it
 * - variants older than `days`, but only while nothing is mid-upload (a resumed upload must see
 *   the exact same bytes, and a regenerated variant is not guaranteed to match)
 */
export function planPrune(home: string, store: Store, opts: PruneOptions): PruneItem[] {
  const now = opts.now.getTime();
  const keepMs = opts.days * DAY;
  const posts = store.listPosts(100_000);
  const targetsByPost = new Map(posts.map((p) => [p.id, store.targetsForPost(p.id)]));
  const byMedia = new Map<string, string[]>();
  // A post owns its video, thumbnail and caption files; all follow the same keep rules.
  for (const p of posts) {
    for (const path of [p.mediaPath, p.thumbnailPath, ...p.captions.map((c) => c.path)]) {
      if (path) byMedia.set(path, [...(byMedia.get(path) ?? []), p.id]);
    }
  }

  const out: PruneItem[] = [];
  for (const f of files(join(home, 'media'))) {
    const owners = byMedia.get(f.path);
    if (!owners) {
      if (now - f.mtimeMs > ORPHAN_GRACE_MS) out.push({ path: f.path, bytes: f.bytes, reason: 'orphan_upload' });
      continue;
    }
    const targets = owners.flatMap((id) => targetsByPost.get(id) ?? []);
    const allDone = targets.every((t) => ['published', 'handed_off', 'removed', 'canceled'].includes(t.state));
    const lastChange = Math.max(f.mtimeMs, ...targets.map((t) => Date.parse(t.updatedAt)));
    if (allDone && now - lastChange > keepMs) out.push({ path: f.path, bytes: f.bytes, reason: 'posted_original' });
  }

  // In flight, or queued for a retry that may resume a half-finished upload.
  const busy = posts.some((p) => (targetsByPost.get(p.id) ?? []).some((t) => !isTerminal(t.state) && (t.state !== 'queued' || t.resume)));
  if (!busy) {
    for (const f of files(join(home, 'variants'))) {
      if (now - f.mtimeMs > keepMs) out.push({ path: f.path, bytes: f.bytes, reason: 'old_variant' });
    }
  }
  return out;
}

export function applyPrune(items: PruneItem[]): number {
  let bytes = 0;
  for (const item of items) {
    rmSync(item.path, { force: true });
    bytes += item.bytes;
  }
  return bytes;
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 ** 3).toFixed(2)}GB`;
}
