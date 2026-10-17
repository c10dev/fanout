import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { SecretBox } from '../src/core/crypto.ts';
import type { Provider } from '../src/core/provider.ts';
import { isStaleOwner, settle, step, type RunnerDeps } from '../src/core/runner.ts';
import { Store } from '../src/core/store.ts';
import type { PostInput } from '../src/core/types.ts';
import { fakeMedia, makeCtx } from './helpers.ts';

const POST: PostInput = { mediaPath: '/v.mp4', title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false };

function slowProvider(delayMs: number): Provider & { publishes: number } {
  const p = {
    id: 'fake',
    displayName: 'Fake',
    capabilities: { nativeSchedule: false, thumbnail: false, captions: false, syntheticMediaFlag: false },
    spec: {},
    appFields: [],
    connectMethod: 'token' as const,
    publishes: 0,
    setupGuide: () => '',
    connect: async () => {
      throw new Error('n/a');
    },
    refresh: async (_c: unknown, a: never) => a,
    validate: () => [],
    publish: async () => {
      p.publishes++;
      await new Promise((r) => setTimeout(r, delayMs));
      return { state: 'published' as const, remoteId: 'R' };
    },
    poll: async () => ({ state: 'published' as const, remoteId: 'R' }),
    doctor: async () => [],
  };
  return p as unknown as Provider & { publishes: number };
}

describe('target leases', () => {
  it('lets one owner at a time hold a target, and expires', () => {
    let now = new Date('2026-10-17T00:00:00Z');
    const { store } = makeCtx(undefined, () => now);
    const { targets } = store.createPost(POST, [{ platform: 'fake', account: 'main', options: {} }]);
    const id = targets[0]!.id;
    assert.equal(store.claim(id, 'a', 60_000), true);
    assert.equal(store.claim(id, 'b', 60_000), false);
    assert.equal(store.claim(id, 'a', 60_000), true, 'holder can renew');
    assert.equal(store.leaseHolder(id), 'a');
    store.release(id, 'b');
    assert.equal(store.leaseHolder(id), 'a', 'only the holder releases');
    now = new Date(now.getTime() + 61_000);
    assert.equal(store.claim(id, 'b', 60_000), true, 'expired lease is free');
    assert.equal(store.claim(id, 'c', 60_000, (h) => h === 'b'), true, 'stale holder can be taken over');
  });

  it('detects dead processes on this host only', () => {
    assert.equal(isStaleOwner(`${hostname()}:${process.pid}:x`), false);
    assert.equal(isStaleOwner(`${hostname()}:2147483646:x`), true);
    assert.equal(isStaleOwner(`some-other-host:2147483646:x`), false);
  });

  it('never uploads the same target twice from two processes', async () => {
    const { ctx, store } = makeCtx(undefined, () => new Date());
    store.saveAccount({ platform: 'fake', name: 'main', credentials: {}, profile: {} });
    const provider = slowProvider(100);
    const base = { ctx, providers: new Map([['fake', provider as Provider]]), probe: async () => fakeMedia(), ensureVariant: async (info: { path: string }) => ({ path: info.path, transcoded: false, reasons: [] }) };
    // Two "processes": different lease owners sharing one database.
    const a: RunnerDeps = { ...base, owner: `${hostname()}:${process.pid}:a` };
    const b: RunnerDeps = { ...base, owner: 'other-host:1:b' };
    const { targets } = store.createPost(POST, [{ platform: 'fake', account: 'main', options: {} }]);
    const id = targets[0]!.id;
    await Promise.all([settle(a, [id], { pollIntervalMs: 1, timeoutMs: 5_000 }), settle(b, [id], { pollIntervalMs: 1, timeoutMs: 5_000 })]);
    assert.equal(provider.publishes, 1);
    assert.equal(store.getTarget(id)!.state, 'published');
    assert.equal(store.leaseHolder(id), undefined, 'released after the step');
  });

  it('leaves a target alone while another process holds it', async () => {
    const { ctx, store } = makeCtx(undefined, () => new Date());
    store.saveAccount({ platform: 'fake', name: 'main', credentials: {}, profile: {} });
    const provider = slowProvider(1);
    const { targets } = store.createPost(POST, [{ platform: 'fake', account: 'main', options: {} }]);
    const id = targets[0]!.id;
    store.claim(id, 'other-host:1:x', 60_000);
    const deps: RunnerDeps = { ctx, providers: new Map([['fake', provider as Provider]]), probe: async () => fakeMedia() };
    const t = await step(deps, id);
    assert.equal(t.state, 'queued');
    assert.equal(provider.publishes, 0);
  });

  it('adds lease columns to an existing database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fanout-migrate-'));
    const path = join(dir, 'fanout.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE targets (id TEXT PRIMARY KEY, post_id TEXT NOT NULL, platform TEXT NOT NULL, account TEXT NOT NULL,
      options TEXT NOT NULL, state TEXT NOT NULL, remote_id TEXT, remote_url TEXT, resume TEXT, warnings TEXT NOT NULL DEFAULT '[]',
      error_code TEXT, error_message TEXT, attempts INTEGER NOT NULL DEFAULT 0, not_before TEXT, updated_at TEXT NOT NULL)`);
    old.close();
    const store = new Store(path, new SecretBox(randomBytes(32)));
    const { targets } = store.createPost(POST, [{ platform: 'fake', account: 'main', options: {} }]);
    assert.equal(store.claim(targets[0]!.id, 'a', 1000), true);
    store.close();
  });
});
