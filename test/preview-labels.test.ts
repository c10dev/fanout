import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import vm from 'node:vm';
import { translate } from '../src/core/i18n.ts';
import { isoInZone, localTime } from '../src/core/insights.ts';
import { previewPost, type TargetPreview } from '../src/core/posting.ts';
import type { PostInput, TargetInput } from '../src/core/types.ts';
import { providerMap } from '../src/providers/index.ts';
import { Dashboard } from '../src/server/server.ts';
import { fakeMedia, makeCtx } from './helpers.ts';

// A scheduled post two days ahead at 00:00 UTC: 09:00 the same day in Asia/Seoul.
const AT = new Date(Math.floor((Date.now() + 2 * 86_400_000) / 86_400_000) * 86_400_000).toISOString();
const SEOUL = `${AT.slice(0, 10)}T09:00:00+09:00`;

const TARGETS: TargetInput[] = [
  { platform: 'youtube', account: 'main', options: { privacy: 'public', madeForKids: false } },
  { platform: 'tiktok', account: 'main', options: { mode: 'direct', privacyLevel: 'SELF_ONLY', musicConsent: true } },
  { platform: 'tiktok', account: 'side', options: { mode: 'inbox' } },
  { platform: 'facebook', account: 'main', options: {} },
  { platform: 'facebook', account: 'drafts', options: { draft: true } },
];

function input(scheduledAt = AT): PostInput {
  return { mediaPath: '/v.mp4', title: 'T', description: '', tags: [], captions: [], containsSyntheticMedia: false, scheduledAt };
}

function store() {
  const env = makeCtx();
  env.store.saveAccount({ platform: 'youtube', name: 'main', credentials: {}, profile: { channelTitle: 'C10' } });
  env.store.saveAccount({ platform: 'tiktok', name: 'main', credentials: {}, profile: { displayName: 'c10e2' } });
  env.store.saveAccount({ platform: 'tiktok', name: 'side', credentials: {}, profile: { displayName: 'c10side' } });
  env.store.saveAccount({ platform: 'facebook', name: 'main', credentials: {}, profile: { pageName: 'C10 Page' } });
  env.store.saveAccount({ platform: 'facebook', name: 'drafts', credentials: {}, profile: { pageName: 'C10 Drafts' } });
  return env;
}

const fields = (p: TargetPreview) => ({ privacy: p.privacy, publishAt: p.publishAt, mode: p.mode });

describe('times in a zone', () => {
  it('writes ISO-8601 with the zone offset, and leaves text that is no time', () => {
    assert.equal(isoInZone('2026-10-20T00:00:00.000Z', 'Asia/Seoul'), '2026-10-20T09:00:00+09:00');
    assert.equal(isoInZone('2026-10-20T00:00:00Z', 'UTC'), '2026-10-20T00:00:00+00:00');
    assert.equal(isoInZone('2026-10-20T00:00:00Z', 'America/St_Johns'), '2026-10-19T21:30:00-02:30');
    assert.equal(isoInZone('next free slot', 'Asia/Seoul'), 'next free slot');
  });

  it('writes the terminal clock without a comma', () => {
    const tz = process.env.TZ;
    process.env.TZ = 'Asia/Seoul';
    try {
      assert.equal(localTime('2026-10-20T00:00:00Z'), '2026-10-20 09:00');
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});

describe('preview of a scheduled post in Asia/Seoul', () => {
  it('gives each target its visibility, time and mode as fields', () => {
    const { store: s } = store();
    const [yt, tt, inbox, fb, draft] = previewPost(s, providerMap(), input(), TARGETS, fakeMedia(), { timeZone: 'Asia/Seoul' });
    assert.deepEqual(fields(yt!), { privacy: 'public', publishAt: AT, mode: 'private_until' });
    assert.deepEqual(fields(tt!), { privacy: 'SELF_ONLY', publishAt: AT, mode: 'direct' });
    assert.deepEqual(fields(inbox!), { privacy: undefined, publishAt: AT, mode: 'inbox' });
    assert.deepEqual(fields(fb!), { privacy: 'public', publishAt: AT, mode: undefined });
    assert.deepEqual(fields(draft!), { privacy: undefined, publishAt: undefined, mode: 'draft' }, 'a draft is not scheduled');
  });

  it('words them in Korean and English with the Seoul offset', () => {
    const { store: s } = store();
    const words = previewPost(s, providerMap(), input(), TARGETS, fakeMedia(), { timeZone: 'Asia/Seoul' }).map((p) => p.visibility);
    assert.deepEqual(words, [
      `private → ${SEOUL}에 public`,
      `direct, SELF_ONLY, ${SEOUL}에 게시`,
      `inbox (TikTok 앱에서 마무리), ${SEOUL}에 보냄`,
      `public, ${SEOUL}에 게시`,
      'draft (Meta Business Suite에서 마무리)',
    ]);
    assert.deepEqual(words.map((w) => translate(w, 'en')), [
      `private → public at ${SEOUL}`,
      `direct, SELF_ONLY, posts at ${SEOUL}`,
      `inbox (finish in the TikTok app), sent at ${SEOUL}`,
      `public, posts at ${SEOUL}`,
      'draft (finish in Meta Business Suite)',
    ]);
  });

  it('falls back to FANOUT_TZ, and leaves unscheduled targets without a time', () => {
    const { store: s } = store();
    const tz = process.env.FANOUT_TZ;
    process.env.FANOUT_TZ = 'Asia/Seoul';
    try {
      const [yt] = previewPost(s, providerMap(), input(), TARGETS.slice(0, 1), fakeMedia(), { timeZone: 'Not/AZone' });
      assert.equal(yt!.visibility, `private → ${SEOUL}에 public`);
    } finally {
      if (tz === undefined) delete process.env.FANOUT_TZ;
      else process.env.FANOUT_TZ = tz;
    }
    const now = previewPost(s, providerMap(), { ...input(), scheduledAt: undefined }, TARGETS, fakeMedia());
    assert.deepEqual(now.map((p) => p.visibility), ['public', 'direct, SELF_ONLY', 'inbox (TikTok 앱에서 마무리)', 'public', 'draft (Meta Business Suite에서 마무리)']);
    assert.ok(now.every((p) => p.publishAt === undefined));
  });
});

describe('dashboard wording of the preview', () => {
  const dir = join(import.meta.dirname, '..', 'src', 'server', 'public');
  const app = readFileSync(join(dir, 'app.js'), 'utf8');
  // The label maps and helpers sit between these two banners and need only i18n.js and the overview.
  const labels = app.slice(app.indexOf('// ── Labels'), app.indexOf('// ── Per-platform option forms'));
  const overview = {
    platforms: [
      { id: 'youtube', displayName: 'YouTube', accounts: [{ name: 'main', label: 'C10' }] },
      { id: 'tiktok', displayName: 'TikTok', accounts: [{ name: 'main', label: 'c10e2' }] },
      { id: 'facebook', displayName: 'Facebook Reels (Page)', accounts: [{ name: 'main', label: 'C10 Page' }] },
    ],
  };
  type Labels = { visibilityText: (p: unknown) => string; targetName: (t: unknown) => string; stateName: (s: string) => string };
  function load(language: string): Labels {
    const sandbox: Record<string, unknown> = {
      navigator: { languages: [language], language },
      localStorage: { getItem: () => null, setItem: () => {} },
      overview,
    };
    vm.runInNewContext(`${readFileSync(join(dir, 'i18n.js'), 'utf8')}\n${labels}\nthis.out = { visibilityText, targetName, stateName };`, sandbox);
    return sandbox.out as Labels;
  }
  const tz = process.env.TZ;
  before(() => {
    // The browser's own zone is the viewer's.
    process.env.TZ = 'Asia/Seoul';
  });
  after(() => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });

  it('shows platform names, visibility labels and the time on the viewer\'s clock, in Korean and English', () => {
    const { store: s } = store();
    const previews = previewPost(s, providerMap(), input(), TARGETS, fakeMedia(), { timeZone: 'UTC' });
    const time = (locale: string) => new Date(AT).toLocaleString(locale, { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' });
    const ko = load('ko-KR');
    assert.deepEqual(previews.map(ko.visibilityText), [
      `비공개 → ${time('ko-KR')}에 공개`,
      `나만 보기, ${time('ko-KR')}에 게시`,
      `${time('ko-KR')}에 TikTok 앱 수신함으로 보냄`,
      `공개, ${time('ko-KR')}에 게시`,
      '게시하지 않고 초안으로 저장 (Meta Business Suite에서 마무리)',
    ]);
    assert.match(time('ko-KR'), /오전 9:00/);
    const en = load('en-US');
    assert.deepEqual(previews.map(en.visibilityText), [
      `Private → Public at ${time('en-US')}`,
      `Only me, posts at ${time('en-US')}`,
      `Sent to the TikTok app inbox at ${time('en-US')}`,
      `Public, posts at ${time('en-US')}`,
      'Save as a draft instead of posting (finish in Meta Business Suite)',
    ]);
    assert.match(time('en-US'), /9:00 AM/);
    assert.equal(en.visibilityText({ platform: 'youtube' }), 'Visibility not set');
    assert.equal(en.visibilityText({ platform: 'mastodon', privacy: 'private' }), 'Followers only');
  });

  it('names targets and states for the board, history and calendar', () => {
    const ko = load('ko-KR');
    assert.equal(ko.targetName({ platform: 'facebook', account: 'main' }), 'Facebook Reels (Page) · C10 Page');
    assert.equal(ko.targetName({ platform: 'x', account: 'main' }), 'x · main', 'the ids when the overview has no such account');
    assert.equal(ko.stateName('handed_off'), '앱에서 마무리');
    assert.equal(load('en-US').stateName('published'), 'Published');
    assert.equal(ko.stateName('mystery'), 'mystery');
  });
});

describe('dashboard preview endpoints', () => {
  const env = store();
  const dashboard = new Dashboard({
    ctx: env.ctx,
    providers: providerMap(),
    port: 0,
    token: 'test-token',
    workerIntervalMs: 60_000,
    probe: async (path) => ({ ...fakeMedia(), path }),
    ensureVariant: async (info) => ({ path: info.path, transcoded: false, reasons: [] }),
  });
  let base = '';
  const auth = { 'x-fanout-token': 'test-token' };
  before(async () => {
    base = (await dashboard.start()).replace(/\/$/, '');
  });
  after(async () => {
    await dashboard.idle();
    await dashboard.stop();
    env.store.close();
  });

  async function preview(query: string, lang = 'ko') {
    const media = (await (await fetch(`${base}/api/media`, { method: 'POST', headers: { ...auth, 'x-filename': 'clip.mp4' }, body: Buffer.alloc(2048, 1) })).json()) as { id: string };
    return fetch(`${base}/api/preview${query}`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json', 'x-fanout-lang': lang },
      body: JSON.stringify({ mediaId: media.id, title: 'T', scheduledAt: AT, targets: TARGETS.slice(0, 2).concat(TARGETS[3]!) }),
    });
  }

  it('returns the fields and words the time in the viewer\'s zone and language', async () => {
    const res = await preview('?tz=Asia%2FSeoul', 'en');
    assert.equal(res.status, 200);
    const { targets } = (await res.json()) as { targets: TargetPreview[] };
    assert.deepEqual(targets.map(fields), [
      { privacy: 'public', publishAt: AT, mode: 'private_until' },
      { privacy: 'SELF_ONLY', publishAt: AT, mode: 'direct' },
      { privacy: 'public', publishAt: AT, mode: undefined },
    ]);
    assert.deepEqual(targets.map((t) => t.visibility), [`private → public at ${SEOUL}`, `direct, SELF_ONLY, posts at ${SEOUL}`, `public, posts at ${SEOUL}`]);
  });

  it('refuses a time zone it does not know', async () => {
    const res = await preview('?tz=Mars%2FOlympus');
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /알 수 없는 시간대/);
  });
});

describe('CLI preview times', () => {
  const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
  function watch(config: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), 'fanout-watch-'));
    writeFileSync(join(dir, 'fanout.watch.json'), JSON.stringify(config));
    const { FANOUT_LANG: _, FANOUT_TZ: __, ...rest } = process.env;
    const r = spawnSync(process.execPath, [CLI, 'watch', dir, '--once'], {
      env: { ...rest, FANOUT_HOME: mkdtempSync(join(tmpdir(), 'fanout-cli-')), FANOUT_LANG: 'en', TZ: 'Asia/Seoul' },
      encoding: 'utf8',
    });
    return r.stdout;
  }

  it('shows the scheduled time on the local clock, in English', () => {
    const out = watch({
      to: ['youtube:main', 'tiktok:main', 'facebook:main'],
      at: AT,
      options: { youtube: { privacy: 'public' }, tiktok: { mode: 'direct', privacyLevel: 'SELF_ONLY' } },
    });
    const local = `${AT.slice(0, 10)} 09:00`;
    assert.match(out, new RegExp(`private → public at ${local}`));
    assert.match(out, new RegExp(`direct, SELF_ONLY, posts at ${local}`));
    assert.match(out, new RegExp(`public, posts at ${local}`));
  });

  it('keeps a slot list whole when it translates the label', () => {
    assert.match(watch({ to: ['facebook:main'], slots: ['09:00', '18:00'] }), /public, posts at next free slot \(09:00 · 18:00\)/);
  });
});
