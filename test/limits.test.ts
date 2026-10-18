import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { openContext } from '../src/core/context.ts';
import { readLimits } from '../src/core/limits.ts';
import { providerMap } from '../src/providers/index.ts';
import { nextPacificMidnight, pacificDay } from '../src/providers/youtube.ts';
import { json, makeCtx, mockFetch } from './helpers.ts';

const NOW = new Date('2026-10-17T03:00:00Z');
const jwt = (expMs: number) => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) })).toString('base64url')}.s`;

describe('posting limits', () => {
  it('YouTube resets at the next Pacific midnight, in and out of daylight saving', () => {
    assert.equal(nextPacificMidnight(NOW).toISOString(), '2026-10-17T07:00:00.000Z', 'PDT: 20:00 on the 16th → midnight is 07:00 UTC');
    assert.equal(nextPacificMidnight(new Date('2026-12-01T12:00:00Z')).toISOString(), '2026-12-02T08:00:00.000Z', 'PST');
    assert.equal(nextPacificMidnight(new Date('2026-11-01T06:30:00Z')).toISOString(), '2026-11-01T07:00:00.000Z', 'the evening before DST ends (still PDT)');
    assert.equal(nextPacificMidnight(new Date('2026-11-01T12:00:00Z')).toISOString(), '2026-11-02T08:00:00.000Z', 'the day DST ends');
  });

  it('reads each account that has limits, and reports one that fails without stopping', async () => {
    const { fetch } = mockFetch([
      ['GET', '/IG/content_publishing_limit', () => json({ data: [{ quota_usage: 47, config: { quota_total: 50 } }] })],
      ['GET', 'com.atproto.server.getServiceAuth', () => json({ error: 'ExpiredToken', message: 'Token has expired' }, 400)],
    ]);
    const { ctx, store } = makeCtx(fetch, () => NOW);
    store.setApp('meta', { appId: 'a', appSecret: 's' });
    store.saveAccount({ platform: 'youtube', name: 'main', credentials: {}, profile: {} });
    store.saveAccount({ platform: 'instagram', name: 'main', credentials: { pageId: 'PAGE', pageToken: 'PT', igUserId: 'IG' }, profile: {} });
    store.saveAccount({ platform: 'mastodon', name: 'main', credentials: {}, profile: {} });
    store.saveAccount({
      platform: 'bluesky',
      name: 'main',
      credentials: { pds: 'https://pds.example', did: 'did:plc:abc', handle: 'me.bsky.social', accessJwt: jwt(NOW.getTime() + 3600_000), refreshJwt: jwt(NOW.getTime() + 86400_000) },
      profile: {},
    });
    store.bumpUsage('youtube', 'project', pacificDay(NOW));
    store.bumpUsage('youtube', 'project', pacificDay(NOW));

    const all = await readLimits(ctx, providerMap());
    assert.deepEqual(all.map((a) => a.platform), ['bluesky', 'instagram', 'youtube'], 'Mastodon has none to read');
    const [bsky, ig, yt] = all;
    assert.ok(bsky!.error && !bsky!.limits.length);
    assert.deepEqual(ig!.limits, [{ what: '24시간 게시', unit: 'posts', used: 47, total: 50, remaining: 3 }]);
    assert.deepEqual(yt!.limits[0], {
      what: '하루 업로드 (프로젝트 전체)',
      unit: 'posts',
      used: 2,
      total: 100,
      remaining: 98,
      resetsAt: '2026-10-17T07:00:00.000Z',
      note: 'fanout이 올린 것만 센 로컬 집계',
    });
    assert.deepEqual((await readLimits(ctx, providerMap(), 'youtube')).map((a) => a.platform), ['youtube']);
  });

  it('a host that never answers is reported after the timeout, not waited on', async () => {
    const { ctx, store } = makeCtx(((_: unknown, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch, () => NOW);
    store.setApp('meta', { appId: 'a', appSecret: 's' });
    store.saveAccount({ platform: 'instagram', name: 'main', credentials: { pageId: 'PAGE', pageToken: 'PT', igUserId: 'IG' }, profile: {} });
    store.saveAccount({ platform: 'youtube', name: 'main', credentials: {}, profile: {} });
    const [ig, yt] = await readLimits(ctx, providerMap(), undefined, 50);
    assert.ok(ig!.error, 'stuck Instagram reported');
    assert.equal(yt!.limits[0]!.used, 0, 'YouTube still read');
  });

  it('Bluesky reports what is left today, and nothing left when uploads are refused', async () => {
    const auth = ['GET', 'com.atproto.server.getServiceAuth', () => json({ token: 'svc' })] as const;
    const account = { pds: 'https://pds.example', did: 'did:plc:abc', handle: 'me.bsky.social', accessJwt: jwt(NOW.getTime() + 3600_000), refreshJwt: jwt(NOW.getTime() + 86400_000) };
    const read = async (limits: unknown) => {
      const { ctx, store } = makeCtx(mockFetch([[...auth], ['GET', 'app.bsky.video.getUploadLimits', () => json(limits)]]).fetch, () => NOW);
      store.saveAccount({ platform: 'bluesky', name: 'main', credentials: account, profile: {} });
      return (await readLimits(ctx, providerMap()))[0]!.limits;
    };
    assert.deepEqual(
      (await read({ canUpload: true, remainingDailyVideos: 25, remainingDailyBytes: 10e9 })).map((l) => [l.what, l.remaining]),
      [['하루 영상', 25], ['하루 용량', 10e9]],
    );
    const refused = await read({ canUpload: false, message: 'daily limit reached' });
    assert.deepEqual(refused.map((l) => [l.remaining, l.note]), [[0, 'daily limit reached'], [0, 'daily limit reached']]);
  });

  it('fanout limits prints them in FANOUT_LANG', () => {
    const home = mkdtempSync(join(tmpdir(), 'fanout-limits-'));
    const ctx = openContext(home);
    ctx.store.saveAccount({ platform: 'youtube', name: 'main', credentials: {}, profile: {} });
    ctx.store.close();
    const { FANOUT_LANG: _, ...env } = process.env;
    const run = (lang?: string) =>
      spawnSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.ts'), 'limits'], { env: { ...env, FANOUT_HOME: home, ...(lang ? { FANOUT_LANG: lang } : {}) }, encoding: 'utf8' }).stdout;
    assert.match(run('en'), /youtube\/main\n {2}Uploads today \(whole project\): 0\/100, 100 left {2}resets .+ {2}\(counted locally, uploads through fanout only\)/);
    assert.match(run(), /하루 업로드 \(프로젝트 전체\): 0\/100, 남은 100/);
  });
});
