import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { SecretBox } from '../src/core/crypto.ts';
import { canTransition, isTerminal } from '../src/core/state.ts';
import type { PostInput } from '../src/core/types.ts';
import { makeCtx } from './helpers.ts';

const POST: PostInput = { mediaPath: '/v.mp4', title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false };

describe('state machine', () => {
  it('allows the happy path and handoff', () => {
    assert.ok(canTransition('queued', 'transcoding'));
    assert.ok(canTransition('transcoding', 'uploading'));
    assert.ok(canTransition('uploading', 'processing'));
    assert.ok(canTransition('processing', 'published'));
    assert.ok(canTransition('processing', 'handed_off'));
  });

  it('forbids leaving terminal success states', () => {
    assert.ok(!canTransition('published', 'queued'));
    assert.ok(!canTransition('handed_off', 'uploading'));
    assert.ok(isTerminal('needs_reauth'));
  });

  it('lets failures be retried', () => {
    assert.ok(canTransition('failed', 'queued'));
    assert.ok(canTransition('needs_reauth', 'queued'));
  });
});

describe('SecretBox', () => {
  it('round-trips and rejects tampering', () => {
    const box = new SecretBox(randomBytes(32));
    const sealed = box.seal('refresh-token-123');
    assert.equal(box.open(sealed), 'refresh-token-123');
    const parts = sealed.split('.');
    parts[3] = Buffer.from('nope').toString('base64url');
    assert.throws(() => box.open(parts.join('.')));
  });

  it('fails with a different key', () => {
    const sealed = new SecretBox(randomBytes(32)).seal('x');
    assert.throws(() => new SecretBox(randomBytes(32)).open(sealed));
  });
});

describe('Store', () => {
  it('stores credentials encrypted at rest', () => {
    const { store, home } = makeCtx();
    store.saveAccount({ platform: 'youtube', name: 'main', credentials: { refreshToken: 'SUPER-SECRET-RT' }, profile: { channelTitle: 'Ch' } });
    store.setApp('youtube', { clientSecret: 'APP-SECRET' });
    assert.equal(store.getAccount<{ refreshToken: string }>('youtube', 'main')?.credentials.refreshToken, 'SUPER-SECRET-RT');
    assert.equal(store.getApp<{ clientSecret: string }>('youtube')?.clientSecret, 'APP-SECRET');
    store.close();
    const raw = readFileSync(join(home, 'fanout.db')).toString('latin1') + readFileSync(join(home, 'fanout.db-wal'), { flag: 'a+' }).toString('latin1');
    assert.ok(!raw.includes('SUPER-SECRET-RT'));
    assert.ok(!raw.includes('APP-SECRET'));
  });

  it('creates targets as queued and logs every transition', () => {
    const { store } = makeCtx();
    const { post, targets } = store.createPost(POST, [
      { platform: 'youtube', account: 'main', options: { privacy: 'public' } },
      { platform: 'tiktok', account: 'main', options: { mode: 'inbox' } },
    ]);
    assert.equal(targets.length, 2);
    assert.ok(targets.every((t) => t.state === 'queued'));
    const yt = targets.find((t) => t.platform === 'youtube')!;
    store.transition(yt.id, 'uploading', { attempts: 1 });
    store.transition(yt.id, 'processing', { remoteId: 'vid1' });
    const done = store.transition(yt.id, 'published', { remoteUrl: 'https://youtu.be/vid1' });
    assert.equal(done.remoteId, 'vid1');
    assert.equal(done.attempts, 1);
    assert.deepEqual(
      store.events(yt.id).map((e) => e.to),
      ['queued', 'uploading', 'processing', 'published'],
    );
    assert.throws(() => store.transition(yt.id, 'uploading'), /illegal/);
    assert.equal(store.findPost(post.id.slice(0, 8))?.id, post.id);
  });

  it('lists only due or in-flight targets as workable', () => {
    const now = new Date('2026-10-17T03:00:00Z');
    const { store } = makeCtx(undefined, () => now);
    const { targets } = store.createPost(POST, [
      { platform: 'a', account: 'main', options: {} },
      { platform: 'b', account: 'main', options: {} },
    ]);
    store.updateTarget(targets[1]!.id, { notBefore: '2026-10-18T00:00:00Z' });
    assert.deepEqual(store.workableTargets().map((t) => t.platform), ['a']);
  });

  it('counts usage per day', () => {
    const { store } = makeCtx();
    store.bumpUsage('youtube', 'project', '2026-10-16');
    assert.equal(store.bumpUsage('youtube', 'project', '2026-10-16'), 2);
    assert.equal(store.getUsage('youtube', 'project', '2026-10-17'), 0);
  });
});
