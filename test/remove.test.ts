import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { priorPosts, removeTarget } from '../src/core/posting.ts';
import { canTransition } from '../src/core/state.ts';
import type { PostInput } from '../src/core/types.ts';
import { providerMap } from '../src/providers/index.ts';
import { json, makeCtx, mockFetch } from './helpers.ts';

const POST: PostInput = { mediaPath: '/v.mp4', title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false, mediaHash: 'h1' };
const NOW = new Date('2026-10-17T03:00:00Z');

function published(platform: string, remoteId: string, credentials: Record<string, unknown>, routes: Parameters<typeof mockFetch>[0]) {
  const { fetch, calls } = mockFetch(routes);
  const env = makeCtx(fetch, () => NOW);
  env.store.saveAccount({ platform, name: 'main', credentials, profile: {} });
  env.store.setApp('meta', { appId: 'a', appSecret: 's' });
  env.store.setApp('youtube', { clientId: 'c', clientSecret: 's' });
  const { targets } = env.store.createPost(POST, [{ platform, account: 'main', options: {} }]);
  const id = targets[0]!.id;
  env.store.transition(id, 'uploading');
  env.store.transition(id, 'published', { remoteId });
  return { ...env, calls, id };
}

describe('removing posts', () => {
  it('allows only published → removed', () => {
    assert.ok(canTransition('published', 'removed'));
    assert.ok(!canTransition('handed_off', 'removed'));
    assert.ok(!canTransition('removed', 'queued'));
  });

  const cases: Array<[string, string, Record<string, unknown>, string, string]> = [
    ['youtube', 'VID', { accessToken: 'A', refreshToken: 'R', expiresAt: NOW.getTime() + 3600_000 }, 'DELETE', '/youtube/v3/videos?id=VID'],
    ['facebook', 'REEL', { pageId: 'P', pageToken: 'PT' }, 'DELETE', '/REEL'],
    ['x', 'TW', { accessToken: 'A', refreshToken: 'R', expiresAt: NOW.getTime() + 3600_000, userId: '1', username: 'me' }, 'DELETE', '/2/tweets/TW'],
    ['bluesky', 'at://did:plc:a/app.bsky.feed.post/KEY', { pds: 'https://pds.example', did: 'did:plc:a', handle: 'h', accessJwt: `h.${Buffer.from(JSON.stringify({ exp: NOW.getTime() / 1000 + 3600 })).toString('base64url')}.s`, refreshJwt: 'r' }, 'POST', 'com.atproto.repo.deleteRecord'],
    ['mastodon', 'S1', { instance: 'https://m.example', token: 'T' }, 'DELETE', '/api/v1/statuses/S1'],
  ];
  for (const [platform, remoteId, credentials, method, url] of cases) {
    it(`${platform}: deletes on the platform and marks the target removed`, async () => {
      const { ctx, store, calls, id } = published(platform, remoteId, credentials, [[method, url, () => (method === 'DELETE' && platform === 'youtube' ? new Response(null, { status: 204 }) : json({ success: true, data: { deleted: true } }))]]);
      const t = await removeTarget(ctx, providerMap(), id);
      assert.equal(t.state, 'removed');
      assert.equal(calls.length, 1);
      if (platform === 'bluesky') assert.deepEqual(JSON.parse(String(calls[0]!.body)), { repo: 'did:plc:a', collection: 'app.bsky.feed.post', rkey: 'KEY' });
      assert.equal(store.events(id).at(-1)!.detail, 'removed by user');
    });
  }

  it('treats an already-deleted post as removed', async () => {
    const { ctx, id } = published('mastodon', 'S1', { instance: 'https://m.example', token: 'T' }, [
      ['DELETE', '/api/v1/statuses/S1', () => json({ error: 'Record not found' }, 404)],
      ['GET', '/api/v1/statuses/S1', () => json({ error: 'Record not found' }, 404)],
    ]);
    assert.equal((await removeTarget(ctx, providerMap(), id)).state, 'removed');
  });

  it('refuses platforms without a delete API and unpublished targets', async () => {
    const ig = published('instagram', 'M', { pageToken: 'PT' }, []);
    await assert.rejects(removeTarget(ig.ctx, providerMap(), ig.id), /API로 삭제할 수 없습니다/);
    const { ctx, store } = makeCtx();
    const { targets } = store.createPost(POST, [{ platform: 'youtube', account: 'main', options: {} }]);
    await assert.rejects(removeTarget(ctx, providerMap(), targets[0]!.id), /게시된 대상만/);
  });

  it('a removed post no longer counts as already posted', async () => {
    const { ctx, store, id } = published('mastodon', 'S1', { instance: 'https://m.example', token: 'T' }, [['DELETE', '/api/v1/statuses/S1', () => json({})]]);
    const targets = [{ platform: 'mastodon', account: 'main', options: {} }];
    assert.equal(priorPosts(store, 'h1', targets).size, 1);
    await removeTarget(ctx, providerMap(), id);
    assert.equal(priorPosts(store, 'h1', targets).size, 0);
  });
});
