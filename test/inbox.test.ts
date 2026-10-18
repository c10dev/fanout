import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { CONFIG_FILE, defaultAccountName, exampleConfig, ingest, loadWatchConfig, nextFreeSlot, planPost, render, Scanner, WatchConfigError, type WatchConfig } from '../src/core/inbox.ts';
import { providerMap } from '../src/providers/index.ts';
import { fakeMedia, makeCtx } from './helpers.ts';

const providers = providerMap();
const NOW = new Date('2026-10-17T03:00:00Z');

function folder(config?: WatchConfig): string {
  const dir = mkdtempSync(join(tmpdir(), 'fanout-watch-'));
  if (config) writeFileSync(join(dir, CONFIG_FILE), JSON.stringify(config));
  return dir;
}

function video(dir: string, name: string, ageMs = 60_000, fill = 1): string {
  const path = join(dir, name);
  writeFileSync(path, Buffer.alloc(1024, fill));
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

describe('watch-folder captions and thumbnails', () => {
  // Sidecars come from whoever can write to the folder: only small caption/image files inside it.
  const plan = (dir: string, sidecar: Record<string, unknown>) =>
    planPost({ videoPath: video(dir, 'a.mp4'), dir, config: { to: ['youtube'], options: { youtube: { privacy: 'unlisted', madeForKids: false } } }, sidecar, media: fakeMedia(), providers, now: NOW });

  it('takes files inside the folder', () => {
    const dir = folder();
    mkdirSync(join(dir, 'subs'));
    writeFileSync(join(dir, 'subs', 'a.ko.srt'), '1\n00:00:00,000 --> 00:00:01,000\n안녕\n');
    writeFileSync(join(dir, 'cover.jpg'), Buffer.alloc(100));
    const p = plan(dir, { captions: { ko: 'subs/a.ko.srt' }, thumbnail: 'cover.jpg' });
    assert.equal(p.input.captions[0]!.path, join(realpathSync(dir), 'subs', 'a.ko.srt'));
    assert.equal(p.input.thumbnailPath, join(realpathSync(dir), 'cover.jpg'));
  });

  it('refuses paths outside the folder, however they get there', () => {
    const dir = folder();
    const outside = mkdtempSync(join(tmpdir(), 'fanout-secret-'));
    writeFileSync(join(outside, 'id_rsa.srt'), 'PRIVATE KEY');
    symlinkSync(join(outside, 'id_rsa.srt'), join(dir, 'link.srt'));
    assert.throws(() => plan(dir, { captions: { en: join(outside, 'id_rsa.srt') } }), /captions\.en: 감시 폴더 안의 상대 경로만/);
    assert.throws(() => plan(dir, { captions: { en: `../${outside.split('/').pop()}/id_rsa.srt` } }), /captions\.en: 감시 폴더 밖의 파일은/);
    assert.throws(() => plan(dir, { captions: { en: 'link.srt' } }), /감시 폴더 밖의 파일은/, 'a symlink out');
    assert.throws(() => plan(dir, { thumbnail: '/etc/hostname' }), /thumbnail: 감시 폴더 안의 상대 경로만/);
  });

  it('refuses files that are not what they claim', () => {
    const dir = folder();
    writeFileSync(join(dir, 'id_rsa'), 'PRIVATE KEY');
    writeFileSync(join(dir, 'big.png'), Buffer.alloc(3 * 1024 * 1024));
    mkdirSync(join(dir, 'dir.srt'));
    assert.throws(() => plan(dir, { captions: { en: 'id_rsa' } }), /captions\.en: \.srt, \.vtt.* 파일만 받습니다/);
    assert.throws(() => plan(dir, { thumbnail: 'big.png' }), /thumbnail: 2MB 이하여야/);
    assert.throws(() => plan(dir, { captions: { en: 'dir.srt' } }), /일반 파일이 아닙니다/);
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
    utimesSync(path, Date.now() / 1000, Date.now() / 1000); // "just now" on the test's clock too
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
    const second = await ingest({ dir, config, videoPath: video(dir, 'clip.mp4', 60_000, 2), providers, store, probe, now: NOW });
    assert.ok(first.ok && second.ok);
    assert.equal(second.movedTo, join(dir, 'posted', 'clip (2).mp4'));
  });
});

describe('duplicate videos', () => {
  const config: WatchConfig = { to: ['youtube', 'tiktok'], options: { youtube: { privacy: 'private', madeForKids: false }, tiktok: { mode: 'inbox' } } };
  const probe = async () => fakeMedia();

  it('skips platform accounts that already got the same video', async () => {
    const { store } = makeCtx();
    const dir = folder(config);
    const first = await ingest({ dir, config: { ...config, to: ['youtube'] }, videoPath: video(dir, 'a.mp4'), providers, store, probe, now: NOW });
    assert.ok(first.ok);
    const copy = await ingest({ dir, config, videoPath: video(dir, 'a-copy.mp4'), providers, store, probe, now: NOW });
    assert.ok(copy.ok);
    if (copy.ok) {
      assert.deepEqual(copy.plan.targets.map((t) => t.platform), ['tiktok']);
      assert.ok(copy.plan.skipped.some((s) => s.platform === 'youtube' && s.reason.includes('이미 올렸습니다')));
    }
  });

  it('moves a video that went everywhere already to failed/, unless onDuplicate is "post"', async () => {
    const { store } = makeCtx();
    const dir = folder(config);
    assert.ok((await ingest({ dir, config, videoPath: video(dir, 'b.mp4'), providers, store, probe, now: NOW })).ok);
    const again = await ingest({ dir, config, videoPath: video(dir, 'b2.mp4'), providers, store, probe, now: NOW });
    assert.equal(again.ok, false);
    assert.match(again.movedTo, /failed/);
    assert.match(readFileSync(`${again.movedTo}.error.txt`, 'utf8'), /이미 올린 영상/);
    const forced = await ingest({ dir, config: { ...config, onDuplicate: 'post' }, videoPath: video(dir, 'b3.mp4'), providers, store, probe, now: NOW });
    assert.ok(forced.ok);
  });

  it('ignores earlier attempts that failed', async () => {
    const { store } = makeCtx();
    const dir = folder(config);
    const first = await ingest({ dir, config, videoPath: video(dir, 'c.mp4'), providers, store, probe, now: NOW });
    assert.ok(first.ok);
    if (first.ok) for (const t of store.targetsForPost(first.postId)) store.transition(t.id, 'failed');
    assert.ok((await ingest({ dir, config, videoPath: video(dir, 'c2.mp4'), providers, store, probe, now: NOW })).ok);
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

describe('posting slots', () => {
  // Local time, like the slots themselves.
  const local = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m);

  it('picks the next slot at least 15 minutes ahead that nothing else takes', () => {
    const slots = ['19:00', '12:00'];
    assert.equal(nextFreeSlot(slots, new Set(), local(17, 10)), local(17, 12).toISOString());
    assert.equal(nextFreeSlot(slots, new Set(), local(17, 18, 50)), local(18, 12).toISOString(), 'too close to 19:00');
    assert.equal(nextFreeSlot(slots, new Set([local(17, 12).toISOString(), local(17, 19).toISOString()]), local(17, 10)), local(18, 12).toISOString());
  });

  it('a batch dropped at once goes out one per slot; a video with its own time keeps it', async () => {
    const { store } = makeCtx();
    const config: WatchConfig = { to: ['youtube'], options: { youtube: { privacy: 'public', madeForKids: false } }, slots: ['19:00'] };
    const dir = folder(config);
    const probe = async () => fakeMedia();
    const now = local(17, 9);
    let fill = 0;
    const at = async (name: string) => {
      // Different bytes each time, or the duplicate check would skip them.
      const r = await ingest({ dir, config, videoPath: video(dir, name, 60_000, ++fill), providers, store, probe, now });
      assert.ok(r.ok);
      return store.getPost(r.postId)!.scheduledAt;
    };
    assert.equal(await at('a.mp4'), local(17, 19).toISOString());
    assert.equal(await at('b.mp4'), local(18, 19).toISOString());
    writeFileSync(join(dir, 'c.json'), JSON.stringify({ at: '2026-11-01T09:00:00Z' }));
    assert.equal(await at('c.mp4'), '2026-11-01T09:00:00.000Z');
    assert.equal(await at('d.mp4'), local(19, 19).toISOString());
  });

  it('a slot whose post was canceled is free again', async () => {
    const { store } = makeCtx();
    const config: WatchConfig = { to: ['youtube'], options: { youtube: { privacy: 'public', madeForKids: false } }, slots: ['19:00'] };
    const dir = folder(config);
    const r = await ingest({ dir, config, videoPath: video(dir, 'a.mp4'), providers, store, probe: async () => fakeMedia(), now: local(17, 9) });
    assert.ok(r.ok);
    for (const t of store.targetsForPost(r.postId)) store.transition(t.id, 'canceled');
    assert.deepEqual(store.scheduledTimes(local(17, 0).toISOString()), []);
  });

  it('rejects malformed slots', () => {
    const dir = folder({ to: ['youtube'], slots: ['7pm'] } as WatchConfig);
    assert.throws(() => loadWatchConfig(dir), /HH:MM/);
  });
});

describe('posting slots, tenth review fixes', () => {
  const local = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m);

  it('refuses slots with a YouTube privacy that cannot be scheduled', () => {
    const dir = folder({ to: ['youtube'], slots: ['19:00'], options: { youtube: { privacy: 'unlisted', madeForKids: false } } } as WatchConfig);
    assert.throws(() => loadWatchConfig(dir), /public/);
  });

  it('a platform that refuses the slotted time is skipped with the reason, the rest still post', async () => {
    const { store } = makeCtx();
    const config: WatchConfig = { to: ['youtube', 'tiktok'], options: { tiktok: { mode: 'inbox' } }, slots: ['19:00'] };
    const dir = folder(config);
    // A sidecar sneaks in an unlisted YouTube privacy past the folder check.
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ options: { youtube: { privacy: 'unlisted', madeForKids: false } } }));
    // YouTube checks the schedule against the real clock, so the slot must really be ahead: tomorrow.
    const tomorrow = new Date(Date.now() + 86_400_000);
    const now = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 9);
    const r = await ingest({ dir, config, videoPath: video(dir, 'a.mp4'), providers, store, probe: async () => fakeMedia(), now });
    assert.ok(r.ok);
    if (r.ok) {
      assert.deepEqual(r.plan.targets.map((t) => t.platform), ['tiktok']);
      assert.match(r.plan.skipped.find((s) => s.platform === 'youtube')!.reason, /public/);
    }
  });

  it('a full calendar moves the video to failed/ instead of crashing the watcher', async () => {
    const { store } = makeCtx();
    const config: WatchConfig = { to: ['tiktok'], options: { tiktok: { mode: 'inbox' } }, slots: ['19:00'] };
    const dir = folder(config);
    const taken = { mediaPath: '/x', title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false };
    for (let d = 0; d < 121; d++) store.createPost({ ...taken, scheduledAt: new Date(2026, 9, 17 + d, 19).toISOString() }, [{ platform: 'tiktok', account: 'main', options: {} }]);
    const r = await ingest({ dir, config, videoPath: video(dir, 'a.mp4'), providers, store, probe: async () => fakeMedia(), now: local(17, 9) });
    assert.ok(!r.ok);
    assert.match(readFileSync(`${r.movedTo}.error.txt`, 'utf8'), /빈 예약 슬롯/);
  });
});

describe('slots across a daylight-saving change', () => {
  it('skips a time the clock jumps over and keeps the order', () => {
    const tz = process.env.TZ;
    process.env.TZ = 'Europe/Berlin';
    try {
      // 2027-03-28: 02:00 → 03:00 in Berlin, so 02:30 doesn't exist that day.
      const now = new Date(2027, 2, 28, 0, 0);
      assert.equal(nextFreeSlot(['02:30', '03:00'], new Set(), now), new Date(2027, 2, 28, 3, 0).toISOString());
      const taken = new Set([new Date(2027, 2, 28, 3, 0).toISOString()]);
      assert.equal(nextFreeSlot(['02:30', '03:00'], taken, now), new Date(2027, 2, 29, 2, 30).toISOString());
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});

describe('watch folder ingest, eleventh review fixes', () => {
  it('a refused database write leaves the video and its sidecar in the inbox', async () => {
    const { store } = makeCtx();
    const config: WatchConfig = { to: ['tiktok'], options: { tiktok: { mode: 'inbox' } } };
    const dir = folder(config);
    const path = video(dir, 'clip.mp4');
    writeFileSync(join(dir, 'clip.json'), JSON.stringify({ title: 'from the sidecar' }));
    store.createPost = () => {
      throw new Error('SQLITE_FULL: database or disk is full');
    };
    await assert.rejects(ingest({ dir, config, videoPath: path, providers, store, probe: async () => fakeMedia(), now: NOW }), /disk is full/);
    assert.ok(existsSync(path) && existsSync(join(dir, 'clip.json')));
    assert.ok(!existsSync(join(dir, 'posted', 'clip.json')));
  });
});

describe('watch folder ingest, twelfth review fixes', () => {
  const config: WatchConfig = { to: ['tiktok'], options: { tiktok: { mode: 'inbox' } }, onDuplicate: 'post' };

  it('a posted/ folder it cannot write to stops before creating anything', async () => {
    const { chmodSync, mkdirSync } = await import('node:fs');
    const { store } = makeCtx();
    const dir = folder(config);
    mkdirSync(join(dir, 'posted'));
    chmodSync(join(dir, 'posted'), 0o500);
    try {
      await assert.rejects(ingest({ dir, config, videoPath: video(dir, 'a.mp4'), providers, store, probe: async () => fakeMedia(), now: NOW }), /쓸 수 없습니다/);
      assert.equal(store.listPosts(10).length, 0);
    } finally {
      chmodSync(join(dir, 'posted'), 0o700);
    }
  });

  it('a video that vanishes before it can move leaves no queued post behind', async () => {
    const { rmSync } = await import('node:fs');
    const { store } = makeCtx();
    const dir = folder(config);
    const path = video(dir, 'a.mp4');
    const tx = store.transaction.bind(store);
    store.transaction = ((fn: () => unknown) => {
      const out = tx(fn);
      rmSync(path, { force: true }); // a sync client takes the file away right after the post is saved
      return out;
    }) as typeof store.transaction;
    await assert.rejects(ingest({ dir, config, videoPath: path, providers, store, probe: async () => fakeMedia(), now: NOW }), /취소했습니다/);
    const [post] = store.listPosts(10);
    assert.deepEqual(store.targetsForPost(post!.id).map((t) => t.state), ['canceled']);
  });
});
