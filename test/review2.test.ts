import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ProviderError } from '../src/core/errors.ts';
import type { Account } from '../src/core/store.ts';
import type { Post, Target } from '../src/core/types.ts';
import { McpServer } from '../src/mcp/server.ts';
import { providerMap } from '../src/providers/index.ts';
import { mastodon } from '../src/providers/mastodon.ts';
import { SEGMENT, weightedLength, x } from '../src/providers/x.ts';
import { fakeMedia, json, makeCtx, mockFetch, tempFile } from './helpers.ts';

const post = (o: Partial<Post> = {}): Post => ({ id: 'p', createdAt: '', mediaPath: '/v.mp4', title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false, ...o });

describe('Mastodon: a lost status response', () => {
  const account: Account = { platform: 'mastodon', name: 'main', credentials: { instance: 'https://m.example', token: 'T' }, profile: {} };
  const setup = (statusHandler: () => Response, now = () => new Date('2026-10-17T03:00:00Z')) => {
    const env = mockFetch([
      ['GET', '/api/v1/media/m1', () => json({ error: 'Record not found' }, 404)], // attached media is no longer listed
      ['POST', '/api/v1/statuses', statusHandler],
    ]);
    const ctx = makeCtx(env.fetch, now);
    const { targets } = ctx.store.createPost(post(), [{ platform: 'mastodon', account: 'main', options: { visibility: 'unlisted' } }]);
    const id = targets[0]!.id;
    const t = () => ({ ...ctx.store.getTarget(id)!, remoteId: 'm1' });
    return { ...ctx, calls: env.calls, id, t };
  };

  it('re-sends with the same Idempotency-Key instead of looking up the attached media', async () => {
    let n = 0;
    const { ctx, store, calls, id, t } = setup(() => (++n === 1 ? (() => { throw new TypeError('fetch failed'); })() : json({ id: 's1', url: 'https://m.example/@me/s1' })));
    store.updateTarget(id, { resume: { mediaId: 'm1' } });
    // First attempt: media ready, status POST loses its response.
    const ready = mockFetch([['GET', '/api/v1/media/m1', () => json({ id: 'm1', url: 'u' })]]);
    const ctxReady = { ...ctx, fetch: (async (u: string, i?: RequestInit) => (String(u).includes('/media/') ? ready.fetch(u, i) : ctx.fetch(u, i))) as typeof fetch };
    await assert.rejects(mastodon.poll({ ctx: ctxReady, post: post(), target: t(), account }));
    assert.equal((store.getTarget(id)!.resume as { posting: boolean }).posting, true);
    // Second attempt: no media GET (it would 404), same key, the server returns the same status.
    const out = await mastodon.poll({ ctx, post: post(), target: t(), account });
    assert.deepEqual([out.state, out.remoteId], ['published', 's1']);
    const keys = calls.filter((c) => c.url.endsWith('/statuses')).map((c) => c.headers['idempotency-key']);
    assert.deepEqual(keys, [`fanout-${id}`, `fanout-${id}`]);
    assert.ok(!calls.some((c) => c.url.includes('/media/')), 'the second poll skipped the media lookup');
  });

  it('stops and asks after the idempotency window instead of risking a duplicate', async () => {
    let now = new Date('2026-10-17T03:00:00Z');
    const { store, ctx, id, t } = setup(() => json({ id: 's1' }), () => now);
    store.updateTarget(id, { resume: { mediaId: 'm1', posting: true, postingAt: now.toISOString() } });
    now = new Date(now.getTime() + 2 * 3600_000);
    await assert.rejects(mastodon.poll({ ctx, post: post(), target: t(), account }), (e: ProviderError) => e.code === 'mastodon.maybe_posted' && e.keepResume);
  });

  it('explains a 404 on media that an earlier attempt already attached', async () => {
    const { store, ctx, id, t } = setup(() => json({ id: 's1' }));
    store.updateTarget(id, { resume: { mediaId: 'm1', posting: false, postingAt: '2026-10-17T02:59:00Z' } });
    await assert.rejects(mastodon.poll({ ctx, post: post(), target: t(), account }), (e: ProviderError) => e.code === 'mastodon.media_attached' && e.keepResume);
  });

  it('posts right away when the schedule is under 5 minutes away', async () => {
    const { store, ctx, calls, id, t } = setup(() => json({ id: 's2', url: 'u' }));
    store.updateTarget(id, { resume: { mediaId: 'm1', posting: true, postingAt: '2026-10-17T03:00:00Z' } });
    const p = post({ scheduledAt: '2026-10-17T03:02:00Z' });
    const out = await mastodon.poll({ ctx, post: p, target: t(), account });
    assert.equal(JSON.parse(String(calls.find((c) => c.url.endsWith('/statuses'))!.body)).scheduled_at, undefined);
    assert.ok(out.warnings?.some((w) => w.includes('바로 게시')));
  });
});

describe('X: dead upload sessions', () => {
  const account: Account = { platform: 'x', name: 'main', profile: {}, credentials: { accessToken: 'A', refreshToken: 'R', expiresAt: Date.parse('2026-10-20T00:00:00Z'), userId: '1', username: 'me' } };
  const target = (resume: Record<string, unknown>): Target => ({ id: 't', postId: 'p', platform: 'x', account: 'main', options: {}, state: 'uploading', warnings: [], attempts: 1, updatedAt: '', resume });

  it('re-initializes once the saved session has expired', async () => {
    const { fetch, calls } = mockFetch([
      ['POST', '/initialize', () => json({ data: { id: 'NEW', expires_after_secs: 86400 } })],
      ['POST', '/NEW/append', () => new Response(null, { status: 204 })],
      ['POST', '/NEW/finalize', () => json({ data: { id: 'NEW' } })],
    ]);
    const { ctx } = makeCtx(fetch, () => new Date('2026-10-19T00:00:00Z'));
    const out = await x.publish({ ctx, post: post(), target: target({ mediaId: 'OLD', segment: 1, expiresAt: Date.parse('2026-10-18T00:00:00Z') }), account, mediaPath: tempFile(SEGMENT + 5), media: fakeMedia(), saveResume: () => {} });
    assert.equal(out.remoteId, 'NEW');
    assert.ok(!calls.some((c) => c.url.includes('/OLD/')));
  });

  it('starts over once when X refuses a resumed session', async () => {
    const { fetch, calls } = mockFetch([
      ['POST', '/OLD/append', () => json({ title: 'Bad Request', detail: 'media id not found' }, 400)],
      ['POST', '/initialize', () => json({ data: { id: 'NEW', expires_after_secs: 86400 } })],
      ['POST', '/NEW/append', () => new Response(null, { status: 204 })],
      ['POST', '/NEW/finalize', () => json({ data: { id: 'NEW' } })],
    ]);
    const { ctx } = makeCtx(fetch, () => new Date('2026-10-17T03:00:00Z'));
    const out = await x.publish({ ctx, post: post(), target: target({ mediaId: 'OLD', segment: 0 }), account, mediaPath: tempFile(100), media: fakeMedia(), saveResume: () => {} });
    assert.equal(out.remoteId, 'NEW');
    assert.equal(calls.filter((c) => c.url.includes('/initialize')).length, 1);
  });

  it('weighs emoji sequences as 2 and bare domains as links', () => {
    assert.equal(weightedLength('👨‍👩‍👧'), 2);
    assert.equal(weightedLength('❤️'), 2);
    assert.equal(weightedLength('x.ai'), 23);
    assert.equal(weightedLength('e.g. v1.2'), 9);
  });
});

describe('MCP hardening', () => {
  const mk = () => {
    const env = makeCtx();
    env.store.saveAccount({ platform: 'youtube', name: 'main', credentials: {}, profile: {} });
    return { ...env, mcp: new McpServer({ ctx: env.ctx, providers: providerMap(), probe: async (p) => ({ ...fakeMedia(), path: p }) }) };
  };
  const call = async (mcp: McpServer, name: string, args: Record<string, unknown>) =>
    ((await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as { result: { isError?: boolean; content: Array<{ text: string }>; structuredContent: Record<string, any> } }).result;

  it('answers null and other non-objects with Invalid Request', async () => {
    const { mcp } = mk();
    for (const raw of [null, 42, [1, 2]]) {
      assert.deepEqual(await mcp.handle(raw), { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    }
  });

  it('won\'t retry a maybe-posted target without the user\'s confirmation', async () => {
    const { mcp, store } = mk();
    const { targets } = store.createPost({ mediaPath: '/v.mp4', title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false }, [{ platform: 'x', account: 'main', options: {} }]);
    const id = targets[0]!.id;
    store.transition(id, 'uploading');
    store.transition(id, 'processing', { remoteId: 'M', resume: { mediaId: 'M', posting: true } });
    store.transition(id, 'failed', { errorCode: 'x.maybe_posted' });
    const refused = await call(mcp, 'retry_target', { targetId: id });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0]!.text, /confirmedNotPosted/);
    assert.equal((await call(mcp, 'retry_target', { targetId: id, confirmedNotPosted: true })).isError, undefined);
  });

  it('accepts only image thumbnails and caption files, and lists them in the preview', async () => {
    const { mcp } = mk();
    const dir = mkdtempSync(join(tmpdir(), 'fanout-mcp-assets-'));
    for (const f of ['v.mp4', 'secret.key', 'cover.png', 'ko.srt']) writeFileSync(join(dir, f), 'x');
    const base = { path: join(dir, 'v.mp4'), title: 'T', targets: [{ platform: 'youtube', options: { privacy: 'unlisted', madeForKids: false } }] };
    const bad = await call(mcp, 'preview_post', { ...base, thumbnailPath: join(dir, 'secret.key') });
    assert.equal(bad.isError, true);
    const badCap = await call(mcp, 'preview_post', { ...base, captions: [{ language: 'ko', path: join(dir, 'secret.key') }] });
    assert.equal(badCap.isError, true);
    const ok = await call(mcp, 'preview_post', { ...base, thumbnailPath: join(dir, 'cover.png'), captions: [{ language: 'ko', path: join(dir, 'ko.srt') }] });
    assert.equal(ok.structuredContent.files.thumbnail, join(dir, 'cover.png'));
    assert.deepEqual(ok.structuredContent.files.captions, [{ language: 'ko', path: join(dir, 'ko.srt') }]);
  });
});
