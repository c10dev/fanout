import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { suggestTimes } from '../src/core/slots.ts';
import type { PostInput } from '../src/core/types.ts';
import { Dashboard } from '../src/server/server.ts';
import { makeCtx } from './helpers.ts';

const POST = (title: string, scheduledAt?: string): PostInput => ({ mediaPath: '/v.mp4', title, description: '', tags: [], captions: [], containsSyntheticMedia: false, ...(scheduledAt ? { scheduledAt } : {}) });
const H = 3600_000;
const MAIN = [{ platform: 'youtube', account: 'main' }];

describe('suggested posting times', () => {
  it('without history: early evening, an hour ahead at least, spaced apart', () => {
    const now = new Date('2026-10-19T03:00:00Z'); // Monday 12:00 in Seoul
    const env = makeCtx(undefined, () => now);
    const r = suggestTimes(env.store, now, { accounts: MAIN, timeZone: 'Asia/Seoul', locale: 'en-US' });
    assert.equal(r.suggestions.length, 3);
    assert.ok(r.note);
    for (const s of r.suggestions) {
      assert.match(s.local, /T(18|19|20):00$/);
      assert.equal(s.basis, 'default');
      assert.ok(Date.parse(s.at) >= now.getTime() + H);
    }
    const ats = r.suggestions.map((s) => Date.parse(s.at));
    for (let i = 1; i < ats.length; i++) assert.ok(ats[i]! - ats[i - 1]! >= 4 * H, 'four hours apart at least');
    assert.equal(r.suggestions[0]!.local, '2026-10-19T18:00', 'the soonest evening first');
  });

  it('keeps clear of posts already going out on the same accounts, not of other accounts', () => {
    const now = new Date('2026-10-19T03:00:00Z');
    const env = makeCtx(undefined, () => now);
    // 19:00 KST today is taken on youtube/main; 18:00 and 20:00 fall inside the 4-hour gap too.
    env.store.createPost(POST('taken', '2026-10-19T10:00:00.000Z'), [{ platform: 'youtube', account: 'main', options: {} }]);
    // Others don't count: a different account, and a canceled post.
    env.store.createPost(POST('other', '2026-10-20T10:00:00.000Z'), [{ platform: 'tiktok', account: 'main', options: {} }]);
    const { targets } = env.store.createPost(POST('canceled', '2026-10-20T09:00:00.000Z'), [{ platform: 'youtube', account: 'main', options: {} }]);
    env.store.transition(targets[0]!.id, 'canceled');
    const r = suggestTimes(env.store, now, { accounts: MAIN, timeZone: 'Asia/Seoul' });
    assert.ok(!r.suggestions.some((s) => s.local.startsWith('2026-10-19')), 'nothing this evening');
    assert.equal(r.suggestions[0]!.local, '2026-10-20T18:00');
  });

  it('follows the weekday and hours insights found best', () => {
    let clock = Date.parse('2026-08-31T00:00:00Z'); // Monday 09:00 in Seoul
    const env = makeCtx(undefined, () => new Date(clock));
    const publish = (title: string, at: number, day1: number) => {
      clock = at;
      const { targets } = env.store.createPost(POST(title), [{ platform: 'youtube', account: 'main', options: {} }]);
      env.store.transition(targets[0]!.id, 'uploading');
      env.store.transition(targets[0]!.id, 'published', { remoteId: title });
      env.store.recordStats(targets[0]!.id, { fetchedAt: new Date(at + 24 * H).toISOString(), views: day1 });
      env.store.saveStats(targets[0]!.id, { fetchedAt: new Date(at + 48 * H).toISOString(), views: day1 * 2 });
    };
    const mon = Date.parse('2026-08-31T00:00:00Z');
    for (let w = 0; w < 4; w++) {
      publish(`fri${w}`, mon + w * 7 * 24 * H + 4 * 24 * H + 10 * H, 900 + w); // Friday 19:00 KST
      publish(`mon${w}`, mon + w * 7 * 24 * H, 100 + w); // Monday 09:00 KST
    }
    const now = new Date(mon + 29 * 24 * H); // Tuesday 2026-09-29 09:00 KST
    clock = now.getTime();
    const r = suggestTimes(env.store, now, { accounts: MAIN, timeZone: 'Asia/Seoul', locale: 'en-US' });
    assert.equal(r.note, undefined);
    // Friday evening matches both the hours and the weekday; other evenings match the hours.
    const friday = r.suggestions.find((s) => /^2026-10-02T(18|19|20):00$/.test(s.local));
    assert.ok(friday, 'Friday evening is among them');
    assert.equal(friday!.reasons.length, 2);
    assert.ok(r.suggestions.every((s) => s.basis === 'history' && /T(18|19|20):00$/.test(s.local)));
    assert.match(friday!.reasons[0]!, /youtube\/main/);
  });

  it('counts when each account actually posted, not when the post was made', () => {
    let clock = Date.parse('2026-10-16T03:00:00Z'); // the post is made three days earlier
    const env = makeCtx(undefined, () => new Date(clock));
    const { post } = env.store.createPost(POST('old'), [{ platform: 'youtube', account: 'main', options: {} }]);
    // TikTok added today and out at 17:00 KST.
    clock = Date.parse('2026-10-19T08:00:00Z');
    const [t] = env.store.addTargets(post.id, [{ platform: 'tiktok', account: 'main', options: {} }]);
    env.store.transition(t!.id, 'uploading');
    env.store.transition(t!.id, 'published', { remoteId: 'T' });
    clock = Date.parse('2026-10-19T08:30:00Z');
    const r = suggestTimes(env.store, new Date(clock), { accounts: [{ platform: 'tiktok', account: 'main' }], timeZone: 'Asia/Seoul' });
    assert.ok(!r.suggestions.some((s) => s.local.startsWith('2026-10-19T')), 'not this evening, an hour after it went out');
  });

  it('suggests whole local hours in zones offset by :45 too', () => {
    const now = new Date('2026-10-19T03:10:00Z');
    const env = makeCtx(undefined, () => now);
    for (const timeZone of ['Asia/Kathmandu', 'Australia/Eucla']) {
      const r = suggestTimes(env.store, now, { accounts: MAIN, timeZone });
      assert.equal(r.suggestions.length, 3, timeZone);
      for (const s of r.suggestions) assert.match(s.local, /T(18|19|20):00$/);
    }
  });

  it('suggests whole local hours in zones offset by half an hour', () => {
    const now = new Date('2026-10-19T03:10:00Z');
    const env = makeCtx(undefined, () => now);
    const r = suggestTimes(env.store, now, { accounts: MAIN, timeZone: 'Asia/Kolkata' });
    for (const s of r.suggestions) {
      assert.match(s.local, /:00$/);
      assert.equal(new Date(s.at).getUTCMinutes(), 30);
    }
  });
});

describe('suggested posting times over HTTP', () => {
  it('needs accounts, checks the time zone, and answers in the asked language', async () => {
    const now = new Date('2026-10-19T03:00:00Z');
    const { ctx } = makeCtx(undefined, () => now);
    const dashboard = new Dashboard({ ctx, providers: new Map(), port: 0, workerIntervalMs: 3_600_000 });
    const base = (await dashboard.start()).replace(/\/$/, '');
    const headers = { 'x-fanout-token': dashboard.token };
    try {
      assert.equal((await fetch(`${base}/api/best-times`, { headers })).status, 400);
      assert.equal((await fetch(`${base}/api/best-times?accounts=youtube/main&tz=Nowhere/Land`, { headers })).status, 400);
      const r = (await (await fetch(`${base}/api/best-times?accounts=youtube/main&tz=Asia/Seoul&lang=en`, { headers: { ...headers, 'x-fanout-lang': 'en' } })).json()) as { timeZone: string; suggestions: Array<{ reasons: string[] }> };
      assert.equal(r.timeZone, 'Asia/Seoul');
      assert.equal(r.suggestions.length, 3);
      assert.match(r.suggestions[0]!.reasons[0]!, /^Not enough history yet/);
    } finally {
      await dashboard.stop();
    }
  });
});
