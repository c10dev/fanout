import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadSecretKey, SecretBox } from '../src/core/crypto.ts';
import type { Provider } from '../src/core/provider.ts';
import { PROCESSING_MAX_MS, step, type RunnerDeps } from '../src/core/runner.ts';
import { Store } from '../src/core/store.ts';
import type { PostInput } from '../src/core/types.ts';
import { fakeMedia, makeCtx } from './helpers.ts';

const POST: PostInput = { mediaPath: '/v.mp4', title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false };

function provider(publish: () => Promise<unknown>, poll: () => Promise<unknown> = async () => ({ state: 'processing', remoteId: 'R' })): Provider {
  return {
    id: 'fake', displayName: 'Fake', spec: {}, appFields: [], connectMethod: 'token',
    capabilities: { nativeSchedule: false, thumbnail: false, captions: false, syntheticMediaFlag: false },
    setupGuide: () => '', connect: async () => { throw new Error('n/a'); }, refresh: async (_c, a) => a,
    validate: () => [], publish: publish as Provider['publish'], poll: poll as Provider['poll'], doctor: async () => [],
  };
}

describe('store under concurrent writers', () => {
  it('busy timeout covers a lock held by a separate process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fanout-busy2-'));
    const path = join(dir, 'fanout.db');
    const store = new Store(path, new SecretBox(randomBytes(32)));
    const { spawn } = await import('node:child_process');
    const holder = spawn(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(${JSON.stringify(path)});
      db.exec('BEGIN IMMEDIATE');
      process.stdout.write('locked');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 500);
    `]);
    await new Promise((r) => holder.stdout.once('data', r));
    const t0 = Date.now();
    store.createPost(POST, [{ platform: 'fake', account: 'main', options: {} }]);
    assert.ok(Date.now() - t0 >= 300, 'waited for the other process');
    assert.equal(store.listPosts().length, 1);
    await new Promise((r) => holder.on('close', r));
    store.close();
  });
});

describe('secret key creation', () => {
  it('creates one complete key even if called repeatedly, leaving no temp files', () => {
    const home = mkdtempSync(join(tmpdir(), 'fanout-key-'));
    const a = loadSecretKey(home);
    const b = loadSecretKey(home);
    assert.equal(a.length, 32);
    assert.deepEqual(a, b);
    assert.deepEqual(readdirSync(home), ['secret.key']);
  });
});

describe('runner safety', () => {
  it('does not write state after losing the lease mid-step', async () => {
    const { ctx, store } = makeCtx(undefined, () => new Date());
    store.saveAccount({ platform: 'fake', name: 'main', credentials: {}, profile: {} });
    const { targets } = store.createPost(POST, [{ platform: 'fake', account: 'main', options: {} }]);
    const id = targets[0]!.id;
    const deps: RunnerDeps = {
      ctx,
      owner: 'this-host:1:a',
      probe: async () => fakeMedia(),
      providers: new Map([[
        'fake',
        provider(async () => {
          // Simulate being suspended past the lease while another process takes over.
          store.release(id, 'this-host:1:a');
          store.claim(id, 'other-host:2:b', 60_000);
          return { state: 'published', remoteId: 'R' };
        }),
      ]]),
    };
    const t = await step(deps, id);
    assert.equal(t.state, 'uploading', 'outcome not written by the old holder');
    assert.equal(store.leaseHolder(id), 'other-host:2:b');
  });

  it('gives up on a target stuck in processing', async () => {
    let now = new Date('2026-10-17T00:00:00Z');
    const { ctx, store } = makeCtx(undefined, () => now);
    store.saveAccount({ platform: 'fake', name: 'main', credentials: {}, profile: {} });
    const { targets } = store.createPost(POST, [{ platform: 'fake', account: 'main', options: {} }]);
    const id = targets[0]!.id;
    store.transition(id, 'uploading');
    store.transition(id, 'processing', { remoteId: 'R' });
    const deps: RunnerDeps = { ctx, probe: async () => fakeMedia(), providers: new Map([['fake', provider(async () => ({}))]]) };
    assert.equal((await step(deps, id)).state, 'processing');
    now = new Date(now.getTime() + PROCESSING_MAX_MS + 60_000);
    const t = await step(deps, id);
    assert.equal(t.state, 'failed');
    assert.equal(t.errorCode, 'processing_timeout');
  });
});
