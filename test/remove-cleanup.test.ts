import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';
import { removeTarget } from '../src/core/posting.ts';
import type { PostInput } from '../src/core/types.ts';
import { providerMap } from '../src/providers/index.ts';
import { youtube } from '../src/providers/youtube.ts';
import { Dashboard } from '../src/server/server.ts';
import { json, makeCtx, mockFetch } from './helpers.ts';

const realSetTimeout = globalThis.setTimeout;
const POST: PostInput = { mediaPath: '/v.mp4', title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false, firstComment: 'link' };
const X = { accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 3_600_000, userId: 'U', username: 'me' };

function publishedX(routes: Parameters<typeof mockFetch>[0], followup?: Record<string, unknown>) {
  const { fetch, calls } = mockFetch(routes);
  const env = makeCtx(fetch);
  env.store.setApp('x', { clientId: 'c' });
  env.store.saveAccount({ platform: 'x', name: 'main', credentials: X, profile: {} });
  const { targets } = env.store.createPost(POST, [{ platform: 'x', account: 'main', options: {} }]);
  const id = targets[0]!.id;
  env.store.transition(id, 'uploading');
  env.store.transition(id, 'published', { remoteId: 'TW1', remoteUrl: 'https://x.com/me/status/TW1' });
  if (followup) env.store.setFollowup(id, followup as never);
  return { ...env, calls, id };
}

describe('removing a post cleans up after itself', () => {
  it('X: deletes the first-comment reply, then the post', async () => {
    const { ctx, calls, id, store } = publishedX([['DELETE', '/2/tweets/', () => json({ data: { deleted: true } })]], { state: 'posted', at: 'x', id: 'TW2' });
    await removeTarget(ctx, providerMap(), id);
    assert.deepEqual(calls.filter((c) => c.method === 'DELETE').map((c) => c.url.split('/').pop()), ['TW2', 'TW1']);
    assert.equal(store.getTarget(id)!.state, 'removed');
  });

  it('X: a reply that could not be deleted leaves the post up too', async () => {
    const { ctx, calls, id, store } = publishedX([['DELETE', '/2/tweets/TW2', () => json({ title: 'Service Unavailable' }, 503)]], { state: 'posted', at: 'x', id: 'TW2' });
    await assert.rejects(removeTarget(ctx, providerMap(), id));
    assert.equal(calls.filter((c) => c.url.endsWith('/TW1')).length, 0);
    assert.equal(store.getTarget(id)!.state, 'published');
  });

  it('X: a reply already gone (404) still lets the post be deleted', async () => {
    const { ctx, calls, id, store } = publishedX(
      [
        ['DELETE', '/2/tweets/TW2', () => json({ title: 'Not Found Error' }, 404)],
        ['DELETE', '/2/tweets/TW1', () => json({ data: { deleted: true } })],
      ],
      { state: 'posted', at: 'x', id: 'TW2' },
    );
    await removeTarget(ctx, providerMap(), id);
    assert.deepEqual(calls.map((c) => c.url.split('/').pop()), ['TW2', 'TW1']);
    assert.equal(store.getTarget(id)!.state, 'removed');
  });

  it('the dashboard and the CLI say the reply goes too', async () => {
    const env = publishedX([], { state: 'posted', at: 'x', id: 'TW2' });
    const dashboard = new Dashboard({ ctx: env.ctx, providers: providerMap(), port: 0, workerIntervalMs: 3_600_000 });
    const base = (await dashboard.start()).replace(/\/$/, '');
    try {
      const board = (await (await fetch(`${base}/api/posts?limit=5`, { headers: { 'x-fanout-token': dashboard.token } })).json()) as Array<{ targets: Array<{ id: string; removesReply?: boolean }> }>;
      assert.equal(board.flatMap((p) => p.targets).find((t) => t.id === env.id)!.removesReply, true);
    } finally {
      await dashboard.stop();
    }
    const home = env.ctx.home;
    const postId = env.store.getTarget(env.id)!.postId;
    env.store.close();
    // Without --yes and with nothing on stdin, the CLI asks and gets no answer: it stops before deleting.
    const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.ts'), 'remove', postId.slice(0, 8), 'x'], { env: { ...process.env, FANOUT_HOME: home, FANOUT_LANG: 'en' }, encoding: 'utf8', input: '' });
    assert.match(r.stdout + r.stderr, /first-comment reply is deleted first/);
  });

  it('X: a reply that may exist without a known id is named on the removed target', async () => {
    const { ctx, calls, id, store } = publishedX([['DELETE', '/2/tweets/', () => json({ data: { deleted: true } })]], { state: 'failed', at: 'x', error: 'timeout', maybePosted: true });
    await removeTarget(ctx, providerMap(), id);
    assert.deepEqual(calls.map((c) => c.url.split('/').pop()), ['TW1']);
    assert.match(store.getTarget(id)!.warnings.join(' '), /첫 댓글 답글/);
  });
});

let hasFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}

describe('youtube doctor --live cleans up', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  it('a status check that fails after the upload still deletes the test video and the clip', async () => {
    const { fetch, calls } = mockFetch([
      ['POST', 'oauth2.googleapis.com/token', () => json({ access_token: 'AT2', expires_in: 3600 })],
      ['GET', '/channels', () => json({ items: [{ id: 'UC1', snippet: { title: 'Ch' } }] })],
      ['POST', '/upload/youtube/v3/videos?', () => new Response(null, { status: 200, headers: { location: 'https://upload.example/session1' } })],
      [
        'PUT',
        'session1',
        () => {
          // The clip is made and probed by now: from here only the 10 s status-check waits are skipped.
          mock.timers.enable({ apis: ['setTimeout'] });
          return json({ id: 'VID9', status: { uploadStatus: 'uploaded', privacyStatus: 'unlisted' } }, 201);
        },
      ],
      ['GET', '/videos?part=status', () => json({ error: { code: 403, message: 'forbidden', errors: [{ reason: 'forbidden' }] } }, 403)],
      ['DELETE', '/videos?id=VID9', () => new Response(null, { status: 204 })],
    ]);
    const { ctx, store } = makeCtx(fetch);
    store.setApp('youtube', { clientId: 'cid', clientSecret: 'cs' });
    const account = { platform: 'youtube', name: 'main', credentials: { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 3_600_000 }, profile: {} };
    store.saveAccount(account);
    const clips = () => readdirSync(tmpdir()).filter((f) => f.startsWith('fanout-doctor-'));
    const before = clips().length;
    try {
      const running = youtube.doctor!({ ctx, account, live: true } as never);
      let done = false;
      void running.finally(() => (done = true));
      // The real setTimeout, for this loop's own waiting: the global one is mocked once the upload starts.
      for (let i = 0; i < 6000 && !done; i++) {
        try {
          mock.timers.tick(10_000);
        } catch {
          // not enabled yet: the clip is still being made
        }
        await new Promise((r) => realSetTimeout(r, 5));
      }
      const checks = await running;
      assert.ok(checks.some((c) => c.status === 'fail'), JSON.stringify(checks));
      const del = checks.find((c) => c.name === '테스트 영상 삭제');
      assert.equal(del?.status, 'ok');
      assert.equal(calls.filter((c) => c.method === 'DELETE').length, 1);
    } finally {
      mock.timers.reset();
    }
    assert.equal(clips().length, before, 'the temp clip is gone');
  });
});
