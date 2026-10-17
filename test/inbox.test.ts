import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { CONFIG_FILE, defaultAccountName, exampleConfig, ingest, loadWatchConfig, planPost, render, Scanner, WatchConfigError, type WatchConfig } from '../src/core/inbox.ts';
import { providerMap } from '../src/providers/index.ts';
import { fakeMedia, makeCtx } from './helpers.ts';

const providers = providerMap();
const NOW = new Date('2026-10-17T03:00:00Z');

function folder(config?: WatchConfig): string {
  const dir = mkdtempSync(join(tmpdir(), 'fanout-watch-'));
  if (config) writeFileSync(join(dir, CONFIG_FILE), JSON.stringify(config));
  return dir;
}

function video(dir: string, name: string, ageMs = 60_000): string {
  const path = join(dir, name);
  writeFileSync(path, Buffer.alloc(1024, 1));
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(path, t, t);
  return path;
}

const BASE: WatchConfig = {
  to: ['youtube', 'tiktok:main', 'instagram', 'facebook'],
  title: '{artist} - {song}',
  description: '{title}\n\n{tags}',
  tags: ['kpop', '가사'],
  vars: { artist: 'Vocado' },
  options: {
    youtube: { privacy: 'public', madeForKids: false },
    tiktok: { mode: 'inbox' },
    instagram: { caption: '{title} {tags}' },
  },
};

describe('render', () => {
  it('fills variables and rejects unknown ones', () => {
    assert.equal(render('{a} / {b}', { a: '1', b: '2' }, 'f'), '1 / 2');
    assert.throws(() => render('{typo}', {}, 'title'), /\{typo\}/);
  });
});

describe('loadWatchConfig', () => {
  it('requires the config file and at least one target', () => {
    assert.throws(() => loadWatchConfig(folder()), /--init/);
    assert.throws(() => loadWatchConfig(folder({ to: [] })), /"to"/);
    assert.throws(() => loadWatchConfig(folder({ to: ['youtube'], tags: 'x' as unknown as string[] })), /문자열 배열/);
    assert.equal(loadWatchConfig(folder(BASE)).title, BASE.title);
  });
});

describe('planPost', () => {
  it('merges folder config, sidecar and template variables', () => {
    const dir = folder(BASE);
    const path = video(dir, 'ditto.mp4');
    const plan = planPost({
      videoPath: path,
      dir,
      config: BASE,
      sidecar: { vars: { song: 'Ditto' }, tags: ['newjeans'], options: { youtube: { privacy: 'unlisted' } } },
      media: fakeMedia({ durationSec: 30 }),
      providers,
      now: NOW,
    });
    assert.equal(plan.input.title, 'Vocado - Ditto');
    assert.deepEqual(plan.input.tags, ['kpop', '가사', 'newjeans']);
    assert.equal(plan.input.description, 'Vocado - Ditto\n\n#kpop #가사 #newjeans');
    assert.equal(plan.input.mediaPath, path);
    const yt = plan.targets.find((t) => t.platform === 'youtube')!;
    assert.deepEqual(yt.options, { privacy: 'unlisted', madeForKids: false });
    assert.equal(plan.targets.find((t) => t.platform === 'instagram')!.options.caption, 'Vocado - Ditto #kpop #가사 #newjeans');
    assert.equal(plan.targets.length, 4);
    assert.deepEqual(plan.skipped, []);
  });

  it('uses the file name as the default title', () => {
    const dir = folder();
    const plan = planPost({
      videoPath: video(dir, '오늘의 단어.mp4'),
      dir,
      config: { to: ['youtube'] },
      sidecar: {},
      media: fakeMedia(),
      providers,
      now: NOW,
    });
    assert.equal(plan.input.title, '오늘의 단어');
  });

  it('skips platforms the video cannot go to, or fails with onBlocked=fail', () => {
    const dir = folder();
    const args = {
      videoPath: video(dir, 'long.mp4'),
      dir,
      sidecar: { vars: { song: 's' } },
      media: fakeMedia({ durationSec: 120 }), // Facebook Reels takes 3–90 s
      providers,
      now: NOW,
    };
    const plan = planPost({ ...args, config: BASE });
    assert.deepEqual(plan.targets.map((t) => t.platform), ['youtube', 'tiktok', 'instagram']);
    assert.equal(plan.skipped[0]!.platform, 'facebook');
    assert.throws(() => planPost({ ...args, config: { ...BASE, onBlocked: 'fail' } }), /facebook/);
  });

  it('rejects missing variables, unknown platforms and missing caption files', () => {
    const dir = folder();
    const base = { videoPath: video(dir, 'a.mp4'), dir, media: fakeMedia(), providers, now: NOW };
    assert.throws(() => planPost({ ...base, config: BASE, sidecar: {} }), /\{song\}/);
    assert.throws(() => planPost({ ...base, config: { to: ['myspace'] }, sidecar: {} }), /myspace/);
    assert.throws(() => planPost({ ...base, config: { to: ['youtube'], captions: { ko: 'nope.srt' } }, sidecar: {} }), WatchConfigError);
  });
});

describe('Scanner', () => {
  it('waits until a file is unchanged across two scans and old enough', () => {
    const dir = folder();
    const path = video(dir, 'a.mp4', 60_000);
    video(dir, 'fresh.mp4', 0);
    writeFileSync(join(dir, 'notes.txt'), 'x');
    const scanner = new Scanner(dir, 10_000);
    assert.deepEqual(scanner.ready(), []); // first sighting
    assert.deepEqual(scanner.ready(), [path]); // stable and 60 s old; fresh.mp4 is too new
    writeFileSync(path, Buffer.alloc(2048, 1)); // still being written
    assert.deepEqual(scanner.ready(), []);
    assert.deepEqual(new Scanner(dir, 10_000).ready(false), []); // one-shot mode: just rewritten, so too new
    const t = (Date.now() - 60_000) / 1000;
    utimesSync(path, t, t);
    assert.deepEqual(new Scanner(dir, 10_000).ready(false), [path]); // one-shot mode needs only the age check
  });
});

describe('ingest', () => {
  it('creates a post and moves the video with its sidecar to posted/', async () => {
    const { store } = makeCtx();
    const dir = folder(BASE);
    const path = video(dir, 'ditto.mp4');
    writeFileSync(join(dir, 'ditto.json'), JSON.stringify({ vars: { song: 'Ditto' } }));
    const r = await ingest({ dir, config: BASE, videoPath: path, providers, store, probe: async () => fakeMedia(), now: NOW });
    assert.ok(r.ok);
    assert.equal(r.movedTo, join(dir, 'posted', 'ditto.mp4'));
    assert.ok(existsSync(join(dir, 'posted', 'ditto.json')));
    assert.ok(!existsSync(path));
    const post = store.getPost(r.postId)!;
    assert.equal(post.title, 'Vocado - Ditto');
    assert.equal(post.mediaPath, r.movedTo);
    assert.equal(store.targetsForPost(post.id).length, 4);
  });

  it('moves a bad video to failed/ with the reason', async () => {
    const { store } = makeCtx();
    const dir = folder(BASE);
    const path = video(dir, 'nosong.mp4');
    const r = await ingest({ dir, config: BASE, videoPath: path, providers, store, probe: async () => fakeMedia(), now: NOW });
    assert.ok(!r.ok);
    assert.equal(r.movedTo, join(dir, 'failed', 'nosong.mp4'));
    assert.match(readFileSync(`${r.movedTo}.error.txt`, 'utf8'), /\{song\}/);
    assert.equal(store.listPosts().length, 0);
  });

  it('does not overwrite an earlier video with the same name', async () => {
    const { store } = makeCtx();
    const config: WatchConfig = { to: ['youtube'], options: { youtube: { privacy: 'private', madeForKids: false } } };
    const dir = folder(config);
    const probe = async () => fakeMedia();
    const first = await ingest({ dir, config, videoPath: video(dir, 'clip.mp4'), providers, store, probe, now: NOW });
    const second = await ingest({ dir, config, videoPath: video(dir, 'clip.mp4'), providers, store, probe, now: NOW });
    assert.ok(first.ok && second.ok);
    assert.equal(second.movedTo, join(dir, 'posted', 'clip (2).mp4'));
  });
});

describe('watch example config', () => {
  it('targets the accounts actually connected', () => {
    const cfg = exampleConfig([
      { platform: 'youtube', name: 'main' },
      { platform: 'tiktok', name: 'mainmain' },
    ]);
    assert.deepEqual(cfg.to, ['youtube:main', 'tiktok:mainmain']);
    assert.deepEqual(Object.keys(cfg.options ?? {}), ['youtube', 'tiktok']);
    assert.equal((cfg.options?.youtube as { privacy: string }).privacy, 'unlisted');
  });

  it('falls back to every platform with "main" when nothing is connected', () => {
    assert.deepEqual(exampleConfig([]).to, ['youtube:main', 'tiktok:main', 'instagram:main', 'facebook:main']);
  });

  it('prefers "main", else the only account', () => {
    assert.equal(defaultAccountName([{ platform: 'tiktok', name: 'a' }, { platform: 'tiktok', name: 'main' }], 'tiktok'), 'main');
    assert.equal(defaultAccountName([{ platform: 'tiktok', name: 'solo' }], 'tiktok'), 'solo');
    assert.equal(defaultAccountName([{ platform: 'tiktok', name: 'a' }, { platform: 'tiktok', name: 'b' }], 'tiktok'), 'main');
  });
});
