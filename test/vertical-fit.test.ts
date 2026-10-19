// A landscape video for Facebook Reels (#234): blocked as is, but marked as one a vertical fit makes
// postable, so the dashboard, CLI and MCP can offer the fit. Nothing pads a video unasked.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { openContext } from '../src/core/context.ts';
import { translate } from '../src/core/i18n.ts';
import { ingest, planPost, type WatchConfig } from '../src/core/inbox.ts';
import { checkMedia, type MediaInfo, type MediaSpec } from '../src/core/media.ts';
import { assessMedia, previewPost } from '../src/core/posting.ts';
import { step } from '../src/core/runner.ts';
import { McpServer } from '../src/mcp/server.ts';
import { facebook } from '../src/providers/facebook.ts';
import { providerMap } from '../src/providers/index.ts';
import { instagram } from '../src/providers/instagram.ts';
import { tiktok } from '../src/providers/tiktok.ts';
import { youtube } from '../src/providers/youtube.ts';
import { Dashboard } from '../src/server/server.ts';
import { fakeMedia, json, makeCtx, mockFetch, tempFile } from './helpers.ts';

const CLI = new URL('../src/cli.ts', import.meta.url).pathname;
const NOW = new Date('2026-10-17T03:00:00Z');
const wide = (): MediaInfo => fakeMedia({ durationSec: 20 }, { width: 1280, height: 720 });
const tall = (): MediaInfo => fakeMedia({ durationSec: 20 }, { width: 1080, height: 1920 });
const ONLY_9_16 = '화면비 1280x720 (1.778) — 9:16만 받습니다';
const PAGE = { platform: 'facebook', name: 'main', credentials: { pageId: 'PAGE', pageToken: 'PT' }, profile: { pageName: 'Vocado' } };

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('assessMedia: a shape a fit would solve', () => {
  it('a 1280x720 video for Facebook is a fittable block, not a transcode, until a fit is chosen', () => {
    const [fb, yt, ig] = assessMedia(wide(), [facebook, youtube, instagram]);
    assert.equal(fb!.verdict, 'blocked');
    assert.equal(fb!.fittable, true);
    const aspect = fb!.violations.find((v) => v.code === 'aspect')!;
    assert.deepEqual([aspect.fixable, aspect.fittable, aspect.message], [false, true, ONLY_9_16]);
    assert.deepEqual([yt!.verdict, yt!.fittable, ig!.verdict, ig!.fittable], ['as_is', undefined, 'as_is', undefined]);

    const [padded] = assessMedia(wide(), [facebook], { facebook: { fit: 'pad' } });
    assert.deepEqual([padded!.verdict, padded!.fittable], ['transcode', undefined]);
    assert.ok(padded!.violations.some((v) => v.code === 'fit' && v.fixable));
    // Anything else under fit is no fit: still blocked, still offered.
    const [typo] = assessMedia(wide(), [facebook], { facebook: { fit: 'stretch' } });
    assert.deepEqual([typo!.verdict, typo!.fittable], ['blocked', true]);
  });

  it('is not fittable when a fit would leave a block, or the video is vertical already', () => {
    const [long] = assessMedia(fakeMedia({ durationSec: 120 }, { width: 1280, height: 720 }), [facebook]);
    assert.deepEqual([long!.verdict, long!.fittable], ['blocked', undefined], '90 s is the limit, fitted or not');
    const [small] = assessMedia(fakeMedia({ durationSec: 20 }, { width: 360, height: 640 }), [facebook]);
    assert.deepEqual([small!.verdict, small!.fittable], ['blocked', undefined], 'a fit leaves a 9:16 video as it is');
    assert.equal(small!.violations.find((v) => v.code === 'resolution_low')!.fittable, undefined);
    // A small landscape video: a fit solves its size as well as its shape.
    const [fb, tt] = assessMedia(fakeMedia({ durationSec: 20 }, { width: 640, height: 352 }), [facebook, tiktok]);
    assert.deepEqual([fb!.fittable, tt!.fittable], [true, true]);
    assert.deepEqual(fb!.violations.filter((v) => !v.fixable).map((v) => [v.code, v.fittable]), [['aspect', true], ['resolution_low', true]]);
  });

  it('names the one shape a platform takes, keeps the range otherwise, and says it in English', () => {
    assert.equal(translate(ONLY_9_16, 'en'), 'aspect 1280x720 (1.778) — 9:16 only');
    const range: MediaSpec = { aspect: { min: 0.5, max: 1 } };
    assert.equal(checkMedia(wide(), range)[0]!.message, '화면비 1280x720 (1.778)가 허용 범위 0.500–1.000 밖');
    assert.equal(checkMedia(wide(), range)[0]!.fittable, undefined, 'a spec that takes no fit offers none');
    assert.deepEqual(checkMedia(tall(), facebook.spec), []);
  });

  it('the preview carries the same flag, and drops it once the target has a fit', () => {
    const { store } = makeCtx();
    store.saveAccount(PAGE);
    const input = { mediaPath: '/v.mp4', title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false };
    const preview = (options: Record<string, unknown>) => previewPost(store, providerMap(), input, [{ platform: 'facebook', account: 'main', options }], wide())[0]!;
    assert.deepEqual([preview({}).verdict, preview({}).fittable, preview({}).errors], ['blocked', true, [ONLY_9_16]]);
    assert.deepEqual([preview({ fit: 'crop' }).verdict, preview({ fit: 'crop' }).fittable], ['transcode', undefined]);
  });
});

describe('/api/preview with and without a fit', () => {
  it('blocks a landscape Facebook target without a fit and converts it with one', async () => {
    const { ctx, store } = makeCtx();
    store.saveAccount(PAGE);
    const dashboard = new Dashboard({ ctx, providers: providerMap(), port: 0, workerIntervalMs: 3_600_000, probe: async (path) => ({ ...wide(), path }) });
    const base = (await dashboard.start()).replace(/\/$/, '');
    const headers = { 'x-fanout-token': dashboard.token };
    try {
      const up = await fetch(`${base}/api/media`, { method: 'POST', headers: { ...headers, 'x-filename': 'wide.mp4' }, body: Buffer.alloc(2048, 3) });
      assert.equal(up.status, 201);
      const { id, assessments } = (await up.json()) as { id: string; assessments: Array<{ platform: string; verdict: string; fittable?: boolean }> };
      const fb = assessments.find((a) => a.platform === 'facebook')!;
      assert.deepEqual([fb.verdict, fb.fittable], ['blocked', true], 'the toggle stays enabled on this');
      assert.equal(assessments.find((a) => a.platform === 'youtube')!.fittable, undefined);

      type Preview = { verdict: string; errors: string[]; transcode: string[]; fittable?: boolean };
      const preview = async (options: Record<string, unknown>, lang = 'ko'): Promise<Preview> => {
        const res = await fetch(`${base}/api/preview`, {
          method: 'POST',
          headers: { ...headers, 'x-fanout-lang': lang, 'content-type': 'application/json' },
          body: JSON.stringify({ mediaId: id, title: 'wide', targets: [{ platform: 'facebook', account: 'main', options }] }),
        });
        assert.equal(res.status, 200);
        return ((await res.json()) as { targets: Preview[] }).targets[0]!;
      };
      const bare = await preview({});
      assert.deepEqual([bare.verdict, bare.fittable, bare.errors], ['blocked', true, [ONLY_9_16]]);
      assert.deepEqual((await preview({}, 'en')).errors, ['aspect 1280x720 (1.778) — 9:16 only']);
      const padded = await preview({ fit: 'pad' });
      assert.deepEqual([padded.verdict, padded.fittable, padded.errors], ['transcode', undefined, []]);
      assert.ok(padded.transcode.includes('세로 9:16으로 맞추고 남는 곳은 흐린 화면으로 채웁니다'));
    } finally {
      await dashboard.stop();
      store.close();
    }
  });
});

describe('watch folder: an explicit fit is honoured, none is never invented', () => {
  const folder = (config: WatchConfig) => {
    const dir = mkdtempSync(join(tmpdir(), 'fanout-watch-fit-'));
    writeFileSync(join(dir, 'fanout.watch.json'), JSON.stringify(config));
    return dir;
  };
  const video = (dir: string, name = 'wide.mp4') => {
    const path = join(dir, name);
    writeFileSync(path, Buffer.alloc(1024, 5));
    return path;
  };
  const youtubeOptions = { privacy: 'private', madeForKids: false };

  it('plans Facebook with the configured fit, and skips it with a hint when there is none', () => {
    const dir = folder({ to: ['facebook'] });
    const base = { videoPath: video(dir), dir, sidecar: {}, media: wide(), providers: providerMap(), now: NOW };
    const fitted = planPost({ ...base, config: { to: ['youtube', 'facebook'], options: { youtube: youtubeOptions, facebook: { fit: 'pad', title: '{name}' } } } });
    assert.deepEqual(fitted.targets.map((t) => [t.platform, t.options.fit]), [['youtube', undefined], ['facebook', 'pad']]);
    assert.equal(fitted.targets[1]!.options.title, 'wide', 'the other options are rendered as before');
    assert.deepEqual(fitted.skipped, []);
    // The sidecar can bring the fit for one video.
    assert.equal(planPost({ ...base, config: { to: ['facebook'] }, sidecar: { options: { facebook: { fit: 'crop' } } } }).targets[0]!.options.fit, 'crop');

    const bare = planPost({ ...base, config: { to: ['youtube', 'facebook'], options: { youtube: youtubeOptions } } });
    assert.deepEqual(bare.targets.map((t) => t.platform), ['youtube'], 'no fit configured: Facebook is skipped as before');
    assert.equal(bare.skipped[0]!.platform, 'facebook');
    assert.match(bare.skipped[0]!.reason, /9:16만 받습니다 \/ options\.facebook\.fit을 "pad"/);
    assert.equal(translate(bare.skipped[0]!.reason, 'en'), 'aspect 1280x720 (1.778) — 9:16 only / set options.facebook.fit to "pad" (blurred fill) or "crop" (the centre) to post it made vertical 9:16');
  });

  it('posts the video to Facebook made vertical with options.facebook.fit = "pad"', async () => {
    const { fetch, calls } = mockFetch([
      ['POST', '/PAGE/video_reels', (c) => (new URLSearchParams(String(c.body)).get('upload_phase') === 'start' ? json({ video_id: 'R1', upload_url: 'https://rupload.facebook.com/video-upload/v24.0/R1' }) : json({ success: true }))],
      ['POST', 'rupload.facebook.com', () => json({ success: true })],
    ]);
    const { ctx, store, home } = makeCtx(fetch);
    store.setApp('meta', { appId: 'a', appSecret: 's' });
    store.saveAccount(PAGE);
    const config: WatchConfig = { to: ['facebook'], options: { facebook: { fit: 'pad' } } };
    const dir = folder(config);
    const variant = tempFile(64);
    const r = await ingest({ dir, config, videoPath: video(dir), providers: providerMap(), store, probe: async () => wide(), now: NOW, mediaDir: join(home, 'media') });
    assert.ok(r.ok, r.ok ? '' : r.error);

    const target = store.targetsForPost(r.postId)[0]!;
    assert.deepEqual([target.platform, target.options.fit], ['facebook', 'pad']);
    const specs: MediaSpec[] = [];
    const deps = {
      ctx,
      providers: providerMap(),
      probe: async (path: string) => (path === variant ? { ...tall(), path } : { ...wide(), path }),
      ensureVariant: async (_info: MediaInfo, spec: MediaSpec) => {
        specs.push(spec);
        return { path: variant, transcoded: true, reasons: [] };
      },
    };
    const done = await step(deps as never, target.id);
    assert.deepEqual([done.state, done.remoteId], ['processing', 'R1']);
    assert.deepEqual(specs.map((s) => s.fit), ['pad'], 'converted with the fit the folder asked for');
    assert.ok(calls.some((c) => c.url.includes('rupload.facebook.com')));
  });

  it('without a fit, a landscape video meant only for Facebook goes to failed/ with the reason', async () => {
    const { store, home } = makeCtx();
    store.saveAccount(PAGE);
    const config: WatchConfig = { to: ['facebook'] };
    const dir = folder(config);
    const r = await ingest({ dir, config, videoPath: video(dir), providers: providerMap(), store, probe: async () => wide(), now: NOW, mediaDir: join(home, 'media') });
    assert.ok(!r.ok);
    assert.ok(existsSync(r.movedTo));
    assert.match(readFileSync(`${r.movedTo}.error.txt`, 'utf8'), /options\.facebook\.fit/);
    assert.equal(store.listPosts().length, 0);
  });
});

describe('MCP: the fit is named, never applied unasked', () => {
  it('check_video and create_post say to add fit; with it the post is made', async () => {
    const env = makeCtx();
    env.store.saveAccount(PAGE);
    const path = join(mkdtempSync(join(tmpdir(), 'fanout-mcp-fit-')), 'wide.mp4');
    writeFileSync(path, 'x');
    const caller = (postWithoutPreview: boolean) => {
      const mcp = new McpServer({ ctx: env.ctx, providers: providerMap(), probe: async (p) => ({ ...wide(), path: p }), worker: { tick: () => {} } as never, postWithoutPreview });
      let id = 0;
      return async (name: string, args: Record<string, unknown>) =>
        ((await mcp.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })) as { result: { isError?: boolean; structuredContent: Record<string, any>; content: Array<{ text: string }> } }).result;
    };
    const call = caller(false);

    const check = await call('check_video', { path });
    const fb = check.structuredContent.platforms.find((p: { platform: string }) => p.platform === 'facebook');
    assert.deepEqual([fb.verdict, fb.fittable], ['blocked', true]);
    assert.match(fb.hint, /fit: "pad"/);
    assert.equal(check.structuredContent.platforms.find((p: { platform: string }) => p.platform === 'youtube').hint, undefined);

    const preview = await call('preview_post', { path, title: 'T', targets: [{ platform: 'facebook' }] });
    assert.match(preview.structuredContent.targets[0].hint, /fit: "pad"/);
    assert.equal(preview.structuredContent.previewId, undefined, 'a blocked preview cannot be posted');
    // Even a server that takes posts without a preview refuses it, and names the fit.
    const refused = await caller(true)('create_post', { path, title: 'T', targets: [{ platform: 'facebook' }] });
    assert.ok(refused.isError);
    assert.match(refused.content[0]!.text, /facebook\/main: .*9:16.* \/ .*fit: "pad"/);
    assert.equal(env.store.listPosts().length, 0, 'nothing made, nothing padded');

    const fitted = { path, title: 'T', targets: [{ platform: 'facebook', options: { fit: 'pad' } }] };
    const previewId = (await call('preview_post', fitted)).structuredContent.previewId;
    const made = await call('create_post', { ...fitted, previewId });
    assert.ok(!made.isError, made.content[0]?.text);
    assert.equal(env.store.targetsForPost(made.structuredContent.postId)[0]!.options.fit, 'pad');
  });
});

describe('fanout check and post (ffmpeg)', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  const clip = () => {
    const path = join(mkdtempSync(join(tmpdir(), 'fanout-check-fit-')), 'wide.mp4');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path]);
    return path;
  };
  const cli = (args: string[], home = mkdtempSync(join(tmpdir(), 'fanout-cli-'))) => spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, FANOUT_LANG: 'en', FANOUT_HOME: home }, encoding: 'utf8', input: '' });

  it('check suggests --vertical for a landscape video Facebook takes only made vertical', () => {
    const r = cli(['check', clip(), '--to', 'facebook,youtube']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /aspect 1280x720 \(1\.778\) — 9:16 only/);
    assert.match(r.stdout, /--vertical pad \(blurred fill\) or crop/);
    assert.equal(r.stdout.match(/--vertical/g)?.length, 1, 'only under Facebook');
  });

  it('post says so before asking, and nothing more once --vertical is given', () => {
    const home = mkdtempSync(join(tmpdir(), 'fanout-cli-'));
    const ctx = openContext(home);
    ctx.store.setApp('meta', { appId: 'a', appSecret: 's' });
    ctx.store.saveAccount(PAGE);
    ctx.store.close();
    const video = clip();
    const bare = cli(['post', video, '--title', 'T', '--to', 'facebook'], home);
    assert.match(bare.stdout, /⚠ facebook\/main: aspect 1280x720 \(1\.778\) — 9:16 only\n.*⚠ facebook\/main: Make it vertical 9:16 with --vertical pad/);
    const fitted = cli(['post', video, '--title', 'T', '--to', 'facebook', '--vertical', 'pad'], home);
    assert.doesNotMatch(fitted.stdout, /9:16 only|--vertical/);
  });
});
