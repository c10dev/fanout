import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { SecretBox } from '../src/core/crypto.ts';
import { exportRows, toCsv } from '../src/core/export.ts';
import { Store } from '../src/core/store.ts';
import type { PostInput } from '../src/core/types.ts';
import { providerMap } from '../src/providers/index.ts';
import { Dashboard } from '../src/server/server.ts';
import { makeCtx } from './helpers.ts';

const POST: PostInput = { mediaPath: '/v.mp4', title: '=HYPERLINK("x") "따옴표", 쉼표', description: '', tags: [], captions: [], containsSyntheticMedia: false };

describe('export', () => {
  it('writes one row per target with state, link and stats', () => {
    const { store } = makeCtx();
    const { targets } = store.createPost(POST, [{ platform: 'youtube', account: 'main', options: {} }, { platform: 'tiktok', account: 'main', options: {} }]);
    store.transition(targets[0]!.id, 'uploading');
    store.transition(targets[0]!.id, 'published', { remoteUrl: 'https://youtu.be/V' });
    store.saveStats(targets[0]!.id, { views: 10, likes: 2, fetchedAt: '2026-10-17T00:00:00Z' });
    const rows = exportRows(store);
    assert.equal(rows.length, 2);
    const yt = rows.find((r) => r.platform === 'youtube')!;
    assert.deepEqual([yt.state, yt.url, yt.views, yt.likes, yt.comments], ['published', 'https://youtu.be/V', '10', '2', '']);
    const csv = toCsv(rows);
    assert.ok(csv.startsWith('﻿postId,'));
    assert.ok(csv.includes(`"'=HYPERLINK(""x"") ""따옴표"", 쉼표"`), 'quoted, escaped and formula-guarded');
  });
});

describe('backup', () => {
  it('produces a readable snapshot of the database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fanout-bak-'));
    const key = randomBytes(32);
    const store = new Store(join(dir, 'fanout.db'), new SecretBox(key));
    store.saveAccount({ platform: 'youtube', name: 'main', credentials: { refreshToken: 'RT' }, profile: {} });
    store.backupTo(join(dir, 'copy.db'));
    store.close();
    const copy = new Store(join(dir, 'copy.db'), new SecretBox(key));
    assert.equal(copy.getAccount<{ refreshToken: string }>('youtube', 'main')?.credentials.refreshToken, 'RT');
    copy.close();
  });
});

describe('health', () => {
  it('answers /healthz without a token', async () => {
    const env = makeCtx();
    const d = new Dashboard({ ctx: env.ctx, providers: providerMap(), port: 0, workerIntervalMs: 60_000, pruneDays: null });
    const url = await d.start();
    try {
      const res = await fetch(`${url}healthz`);
      assert.deepEqual([res.status, await res.json()], [200, { ok: true }]);
    } finally {
      await d.stop();
    }
  });
});
