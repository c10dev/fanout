import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { printable } from '../src/cli.ts';
import { fetchComments, refreshStats, removeTarget } from '../src/core/posting.ts';
import type { PostInput } from '../src/core/types.ts';
import { providerMap } from '../src/providers/index.ts';
import { presetOptions } from '../src/server/server.ts';
import { json, makeCtx, mockFetch } from './helpers.ts';

const POST: PostInput = { mediaPath: '/v.mp4', title: 't', description: 'd', tags: [], captions: [], containsSyntheticMedia: false };

function published(
  platform: string,
  credentials: Record<string, unknown>,
  profile: Record<string, unknown>,
  remote: { remoteId: string; remoteUrl?: string; resume?: Record<string, unknown> },
  routes: Parameters<typeof mockFetch>[0],
) {
  const { fetch, calls } = mockFetch(routes);
  const env = makeCtx(fetch);
  env.store.setApp('meta', { appId: 'a', appSecret: 's' });
  env.store.saveAccount({ platform, name: 'main', credentials, profile });
  const { post, targets } = env.store.createPost(POST, [{ platform, account: 'main', options: {} }]);
  const id = targets[0]!.id;
  env.store.transition(id, 'uploading');
  env.store.transition(id, 'published', remote);
  return { ...env, calls, id, postId: post.id };
}

describe('presets never carry per-post choices', () => {
  it('drops TikTok privacy, interaction, commercial and consent fields and YouTube visibility', () => {
    assert.deepEqual(
      presetOptions('tiktok', { mode: 'direct', privacyLevel: 'PUBLIC_TO_EVERYONE', allowComment: true, allowDuet: true, allowStitch: true, brandOrganic: true, brandedContent: true, musicConsent: true, caption: 'c' }),
      { mode: 'direct', caption: 'c' },
    );
    assert.deepEqual(presetOptions('youtube', { privacy: 'public', madeForKids: false, categoryId: '22' }), { categoryId: '22' });
    assert.deepEqual(presetOptions('mastodon', { visibility: 'public' }), { visibility: 'public' });
    assert.deepEqual(presetOptions('tiktok', 'nope'), {});
  });
});

describe('Mastodon acts only through the connection that posted', () => {
  const md = { instance: 'https://new.example', token: 'T' };

  it('refuses to remove a post made on another instance', async () => {
    const { ctx, store, calls, id } = published('mastodon', md, { accountId: '1' }, { remoteId: 'S1', remoteUrl: 'https://old.example/@me/S1' }, []);
    await assert.rejects(removeTarget(ctx, providerMap(), id), /old\.example/);
    assert.equal(store.getTarget(id)!.state, 'published');
    assert.equal(calls.length, 0);
  });

  it('refuses to remove a post made by another account on the same instance', async () => {
    const { ctx, calls, id } = published('mastodon', md, { accountId: '2' }, { remoteId: 'S1', resume: { instance: 'https://new.example', accountId: '1' } }, []);
    await assert.rejects(removeTarget(ctx, providerMap(), id), /올린 글이 아닙니다/);
    assert.equal(calls.length, 0);
  });

  it('a failing check after a 404 does not count as gone', async () => {
    const { ctx, store, id } = published('mastodon', md, { accountId: '1' }, { remoteId: 'S1', resume: { instance: 'https://new.example', accountId: '1' } }, [
      ['DELETE', '/api/v1/statuses/S1', () => json({ error: 'Record not found' }, 404)],
      ['GET', '/api/v1/statuses/S1', () => json({ error: 'busy' }, 503)],
    ]);
    await assert.rejects(removeTarget(ctx, providerMap(), id));
    assert.equal(store.getTarget(id)!.state, 'published');
  });

  it('a 404 on both delete and check from the posting account is gone', async () => {
    const { ctx, id } = published('mastodon', md, { accountId: '1' }, { remoteId: 'S1', resume: { instance: 'https://new.example', accountId: '1' } }, [
      ['DELETE', '/api/v1/statuses/S1', () => json({ error: 'Record not found' }, 404)],
      ['GET', '/api/v1/statuses/S1', () => json({ error: 'Record not found' }, 404)],
    ]);
    assert.equal((await removeTarget(ctx, providerMap(), id)).state, 'removed');
  });

  it('does not read comments or stats of a scheduled status by its scheduled id', async () => {
    const { ctx, store, calls, id, postId } = published('mastodon', md, { accountId: '1' }, { remoteId: 'SCH1', resume: { scheduled: true } }, []);
    const [r] = await fetchComments(ctx, providerMap(), postId);
    assert.match(r!.error ?? '', /예약/);
    await refreshStats(ctx, providerMap(), postId);
    assert.match(store.getTarget(id)!.stats?.note ?? '', /예약/);
    assert.equal(calls.length, 0);
  });
});

describe('YouTube comments by other people', () => {
  it('fall back to textDisplay when textOriginal is withheld', async () => {
    const { ctx, calls, postId } = published('youtube', { accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 3_600_000 }, {}, { remoteId: 'V1' }, [
      [
        'GET',
        '/commentThreads',
        () =>
          json({
            items: [{ id: 'C1', snippet: { totalReplyCount: 0, topLevelComment: { snippet: { authorDisplayName: 'fan', textDisplay: '좋아요', publishedAt: '2026-10-17T00:00:00Z' } } } }],
          }),
      ],
    ]);
    const [r] = await fetchComments(ctx, providerMap(), postId);
    assert.equal(r!.comments?.[0]?.text, '좋아요');
    assert.match(calls[0]!.url, /textFormat=plainText/);
  });
});

describe('Facebook remove after the reel is already gone', () => {
  const fb = { pageId: 'P1', pageToken: 'PT' };
  const gone = () => json({ error: { code: 100, error_subcode: 33, message: 'does not exist' } }, 400);

  it('is removed when the posting Page can read itself but not the reel', async () => {
    const { ctx, id } = published('facebook', fb, {}, { remoteId: 'R1', resume: { videoId: 'R1', finished: true, pageId: 'P1' } }, [
      ['DELETE', '/R1', gone],
      ['GET', '/R1', gone],
      ['GET', '/P1', () => json({ id: 'P1' })],
    ]);
    assert.equal((await removeTarget(ctx, providerMap(), id)).state, 'removed');
  });

  it('stays published when posted from another Page', async () => {
    const { ctx, store, id } = published('facebook', fb, {}, { remoteId: 'R1', resume: { videoId: 'R1', finished: true, pageId: 'P0' } }, [['DELETE', '/R1', gone]]);
    await assert.rejects(removeTarget(ctx, providerMap(), id), /페이지에서 직접 확인/);
    assert.equal(store.getTarget(id)!.state, 'published');
  });
});

describe('CLI output of other people’s text', () => {
  it('strips terminal escapes and bidi overrides', () => {
    assert.equal(printable('hi\u001b]0;pwned\u0007 there‮\nnext'), 'hi]0;pwned there next');
  });
});
