import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { CONFIG_FILE, loadWatchConfig } from '../src/core/inbox.ts';
import { notifyConfig } from '../src/core/notify.ts';
import { editPost, removeTarget } from '../src/core/posting.ts';
import type { PostInput } from '../src/core/types.ts';
import { providerMap } from '../src/providers/index.ts';
import { json, makeCtx, mockFetch } from './helpers.ts';

const POST: PostInput = { mediaPath: '/v.mp4', title: 't', description: 'd', tags: [], captions: [], containsSyntheticMedia: false };

function published(platform: string, credentials: Record<string, unknown>, remoteId: string, resume: Record<string, unknown> | undefined, routes: Parameters<typeof mockFetch>[0], options: Record<string, unknown> = {}) {
  const { fetch, calls } = mockFetch(routes);
  const env = makeCtx(fetch);
  env.store.setApp('meta', { appId: 'a', appSecret: 's' });
  env.store.saveAccount({ platform, name: 'main', credentials, profile: { username: 'me@m.example' } });
  const { post, targets } = env.store.createPost(POST, [{ platform, account: 'main', options }]);
  const id = targets[0]!.id;
  env.store.transition(id, 'uploading');
  env.store.transition(id, 'published', { remoteId, resume });
  return { ...env, calls, id, postId: post.id };
}

describe('removal never reports a live post as removed', () => {
  const md = { instance: 'https://m.example', token: 'T' };

  it('Mastodon: cancels a scheduled status through scheduled_statuses', async () => {
    const { ctx, calls, id } = published('mastodon', md, 'SCH1', { scheduled: true }, [['DELETE', '/api/v1/scheduled_statuses/SCH1', () => json({})]]);
    assert.equal((await removeTarget(ctx, providerMap(), id)).state, 'removed');
    assert.equal(calls.length, 1);
  });

  it('Mastodon: a scheduled status that already fired is not marked removed', async () => {
    const { ctx, store, id } = published('mastodon', md, 'SCH1', { scheduled: true }, [['DELETE', '/api/v1/scheduled_statuses/SCH1', () => json({ error: 'Record not found' }, 404)]]);
    await assert.rejects(removeTarget(ctx, providerMap(), id), /이미 게시됐을 수 있습니다/);
    assert.equal(store.getTarget(id)!.state, 'published');
  });

  it('Mastodon: a 404 on a still-existing status of another account is refused', async () => {
    const { ctx, store, id } = published('mastodon', md, 'S9', undefined, [
      ['DELETE', '/api/v1/statuses/S9', () => json({ error: 'Record not found' }, 404)],
      ['GET', '/api/v1/statuses/S9', () => json({ id: 'S9', account: { id: 'someone-else' } })],
    ]);
    await assert.rejects(removeTarget(ctx, providerMap(), id), /지울 수 없습니다/);
    assert.equal(store.getTarget(id)!.state, 'published');
  });

  it('Facebook: code 100 means cannot see it, not already gone', async () => {
    const { ctx, store, id } = published('facebook', { pageId: 'P2', pageToken: 'PT' }, 'R1', undefined, [
      ['DELETE', '/R1', () => json({ error: { code: 100, error_subcode: 33, message: 'Unsupported delete request' } }, 400)],
    ]);
    await assert.rejects(removeTarget(ctx, providerMap(), id), /페이지에서 직접 확인/);
    assert.equal(store.getTarget(id)!.state, 'published');
  });

  it('Bluesky: refuses to delete from a repo other than the one holding the post', async () => {
    const jwt = `h.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600 })).toString('base64url')}.s`;
    const { ctx, calls, id } = published('bluesky', { pds: 'https://pds', did: 'did:plc:new', handle: 'new', accessJwt: jwt, refreshJwt: 'r' }, 'at://did:plc:old/app.bsky.feed.post/K', undefined, []);
    await assert.rejects(removeTarget(ctx, providerMap(), id), /지울 수 없습니다/);
    assert.equal(calls.length, 0);
  });
});

describe('editing reports honestly', () => {
  it('skips targets with their own caption/text and queued targets that already started uploading', async () => {
    const { fetch } = mockFetch([]);
    const { ctx, store } = makeCtx(fetch);
    store.saveAccount({ platform: 'mastodon', name: 'main', credentials: { instance: 'https://m.example', token: 'T' }, profile: {} });
    const { post, targets } = store.createPost(POST, [
      { platform: 'mastodon', account: 'main', options: { visibility: 'public', text: '내가 쓴 글' } },
      { platform: 'youtube', account: 'main', options: {} },
    ]);
    const [md, yt] = targets.map((t) => t.id) as [string, string];
    store.transition(md, 'uploading');
    store.transition(md, 'published', { remoteId: 'S1' });
    store.transition(yt, 'uploading', { resume: { sessionUri: 'https://upload/s', size: 10 } });
    store.transition(yt, 'queued');
    const by = Object.fromEntries((await editPost(ctx, providerMap(), post.id, { title: 'new' })).map((r) => [r.platform, r]));
    assert.match(by.mastodon!.detail!, /따로 지정해/);
    assert.match(by.youtube!.detail!, /올리는 중이라 반영되지 않았습니다/);
  });
});

describe('config validation', () => {
  it('rejects an onDuplicate typo instead of posting duplicates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fanout-dup-'));
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ to: ['youtube'], onDuplicate: 'Skip' }));
    assert.throws(() => loadWatchConfig(dir), /onDuplicate/);
  });

  it('ignores an unparseable webhook instead of breaking notifications', () => {
    const { ctx, store } = makeCtx();
    store.setApp('notify', { url: 'https://hooks example.com/x' });
    assert.equal(notifyConfig(ctx), undefined);
    process.env.FANOUT_WEBHOOK_URL = 'not a url';
    try {
      assert.equal(notifyConfig(ctx), undefined);
    } finally {
      delete process.env.FANOUT_WEBHOOK_URL;
    }
  });
});
