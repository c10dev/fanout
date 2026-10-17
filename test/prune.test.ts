import assert from 'node:assert/strict';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { applyPrune, planPrune } from '../src/core/prune.ts';
import type { PostInput } from '../src/core/types.ts';
import { makeCtx } from './helpers.ts';

const DAY = 86_400_000;
const NOW = new Date('2026-10-30T00:00:00Z');

function file(dir: string, name: string, ageDays: number): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, Buffer.alloc(1000));
  const t = new Date(NOW.getTime() - ageDays * DAY);
  utimesSync(path, t, t);
  return path;
}

function post(mediaPath: string): PostInput {
  return { mediaPath, title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false };
}

describe('prune', () => {
  it('removes old orphans, finished originals and stale variants only', () => {
    let clock = new Date(NOW.getTime() - 20 * DAY);
    const { store, home } = makeCtx(undefined, () => clock);
    const media = join(home, 'media');
    const freshOrphan = file(media, 'fresh.mp4', 0.2);
    const oldOrphan = file(media, 'old.mp4', 3);
    const done = file(media, 'done.mp4', 20);
    const failed = file(media, 'failed.mp4', 20);
    const recentDone = file(media, 'recent.mp4', 20);

    const mk = (path: string, final: 'published' | 'failed', at: Date) => {
      clock = at;
      const { targets } = store.createPost(post(path), [{ platform: 'youtube', account: 'main', options: {} }]);
      store.transition(targets[0]!.id, 'uploading');
      store.transition(targets[0]!.id, final);
    };
    mk(done, 'published', new Date(NOW.getTime() - 20 * DAY));
    mk(failed, 'failed', new Date(NOW.getTime() - 20 * DAY));
    mk(recentDone, 'published', new Date(NOW.getTime() - 2 * DAY));
    const oldVariant = file(join(home, 'variants'), 'v1.mp4', 10);
    const newVariant = file(join(home, 'variants'), 'v2.mp4', 1);

    const items = planPrune(home, store, { days: 7, now: NOW });
    assert.deepEqual(
      items.map((i) => [i.path, i.reason]).sort(),
      [
        [done, 'posted_original'],
        [oldOrphan, 'orphan_upload'],
        [oldVariant, 'old_variant'],
      ].sort(),
    );
    assert.equal(applyPrune(items), 3000);
    assert.ok(!existsSync(done) && !existsSync(oldOrphan) && !existsSync(oldVariant));
    for (const kept of [freshOrphan, failed, recentDone, newVariant]) assert.ok(existsSync(kept), kept);
  });

  it('keeps every variant while an upload could resume', () => {
    const { store, home } = makeCtx(undefined, () => NOW);
    const variant = file(join(home, 'variants'), 'v.mp4', 30);
    const { targets } = store.createPost(post('/elsewhere.mp4'), [{ platform: 'youtube', account: 'main', options: {} }]);
    store.transition(targets[0]!.id, 'uploading', { resume: { sessionUri: 'https://upload.example/s' } });
    store.transition(targets[0]!.id, 'queued');
    assert.deepEqual(planPrune(home, store, { days: 7, now: NOW }), []);
    assert.ok(existsSync(variant));
  });

  it('treats a pending post\'s thumbnail and captions as in use', () => {
    const { store, home } = makeCtx(undefined, () => NOW);
    const media = join(home, 'media');
    const video = file(media, 'v.mp4', 5);
    const thumb = file(media, 't.png', 5);
    const sub = file(media, 'ko.srt', 5);
    store.createPost({ ...post(video), thumbnailPath: thumb, captions: [{ language: 'ko', path: sub }] }, [{ platform: 'youtube', account: 'main', options: {} }]);
    assert.deepEqual(planPrune(home, store, { days: 7, now: NOW }), []);
  });

  it('never looks outside the fanout home', () => {
    const { store, home } = makeCtx(undefined, () => NOW);
    const outside = file(join(home, '..', `watch-${Date.now()}`, 'posted'), 'clip.mp4', 100);
    const { targets } = store.createPost(post(outside), [{ platform: 'youtube', account: 'main', options: {} }]);
    store.transition(targets[0]!.id, 'uploading');
    store.transition(targets[0]!.id, 'published');
    assert.deepEqual(planPrune(home, store, { days: 0, now: NOW }), []);
  });
});
