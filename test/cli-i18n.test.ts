import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { openContext } from '../src/core/context.ts';
import { currentLang, msg, translate } from '../src/core/i18n.ts';
import { McpServer } from '../src/mcp/server.ts';
import { providerMap } from '../src/providers/index.ts';
import { fakeMedia, makeCtx } from './helpers.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

function cli(args: string[], env: Record<string, string> = {}, home = mkdtempSync(join(tmpdir(), 'fanout-cli-'))) {
  const { FANOUT_LANG: _, ...rest } = process.env;
  const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...rest, LANG: 'en_US.UTF-8', FANOUT_HOME: home, ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function withLang<T>(lang: string | undefined, fn: () => T): T {
  const before = process.env.FANOUT_LANG;
  if (lang === undefined) delete process.env.FANOUT_LANG;
  else process.env.FANOUT_LANG = lang;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.FANOUT_LANG;
    else process.env.FANOUT_LANG = before;
  }
}

describe('terminal language', () => {
  it('is English only when FANOUT_LANG asks for it', () => {
    assert.equal(withLang(undefined, currentLang), 'ko');
    assert.equal(withLang('en', currentLang), 'en');
    assert.equal(withLang('en_US.UTF-8', currentLang), 'en');
    assert.equal(withLang('ko', currentLang), 'ko');
    assert.equal(withLang('fr', currentLang), 'ko');
  });

  it('translates a message behind a platform or account label', () => {
    const inner = msg('제목을 입력하세요');
    assert.equal(translate(`youtube/main: ${inner}`, 'en'), 'youtube/main: Enter a title');
    assert.equal(translate(`- tiktok — ${inner}`, 'en'), '- tiktok — Enter a title');
    assert.equal(translate(`x (${inner})`, 'en'), 'x (Enter a title)');
    // One platform per line, its reasons joined with " / ".
    const skipped = [`  youtube: ${inner} / ${msg('파일이 너무 큽니다')}`, `  x: ${msg('파일이 너무 큽니다')}`].join('\n');
    assert.equal(translate(msg('올릴 수 있는 플랫폼이 없습니다:\n{skipped}', { skipped }), 'en'), 'No platform can take it:\n  youtube: Enter a title / The file is too large\n  x: The file is too large');
    assert.equal(translate('youtube: 처음 보는 오류', 'en'), 'youtube: 처음 보는 오류', 'unknown text after a label stays');
  });
});

describe('CLI in English', () => {
  it('stays Korean by default, whatever the system locale', () => {
    const r = cli(['doctor']);
    assert.match(r.out, /연결된 계정이 없습니다/);
  });

  it('prints help, errors and output in English with FANOUT_LANG=en', () => {
    const help = cli(['help'], { FANOUT_LANG: 'en' });
    assert.match(help.out, /self-hosted uploader that posts one video to many platforms/);
    assert.doesNotMatch(help.out, /[가-힣]/);

    const unknown = cli(['nope'], { FANOUT_LANG: 'en' });
    assert.equal(unknown.code, 2);
    assert.match(unknown.err, /^Unknown command: nope\n\nfanout — a self-hosted uploader/);

    const usage = cli(['post', 'missing.mp4', '--title', 'T', '--to', 'youtube'], { FANOUT_LANG: 'en' });
    assert.match(usage.err, /No such file: .*missing\.mp4/);

    assert.equal(cli(['status'], { FANOUT_LANG: 'en' }).out.trim(), 'No posts');
    assert.equal(cli(['disconnect', 'mastodon', 'main'], { FANOUT_LANG: 'en' }).out.trim(), 'No such account');
    const name = cli(['connect', 'mastodon', '--name', '실패'], { FANOUT_LANG: 'en' });
    assert.equal(name.code, 2);
    assert.match(name.err, /^Account names/);
  });

  it('shows stored Korean messages in English, but not the post title', () => {
    const home = mkdtempSync(join(tmpdir(), 'fanout-cli-'));
    const ctx = openContext(home);
    const input = { title: '파일이 너무 큽니다', mediaPath: '/x.mp4', description: '', tags: [], captions: [], containsSyntheticMedia: false };
    const { post, targets: [t] } = ctx.store.createPost(input, [{ platform: 'youtube', account: 'main', options: {} }]);
    ctx.store.transition(t!.id, 'failed', { errorCode: 'preflight', errorMessage: msg('제목을 입력하세요') }, 'test');
    ctx.store.close();

    const r = cli(['status', post.id], { FANOUT_LANG: 'en' }, home);
    assert.match(r.out, /"파일이 너무 큽니다"/, 'the title is user content');
    assert.match(r.out, /preflight: Enter a title/);
    assert.match(cli(['status', post.id], {}, home).out, /preflight: 제목을 입력하세요/);
  });
});

describe('MCP in English', () => {
  it('answers in English with FANOUT_LANG=en and leaves titles alone', async () => {
    const env = makeCtx();
    env.store.saveAccount({ platform: 'youtube', name: 'main', credentials: {}, profile: { channelTitle: 'C10' } });
    const video = join(mkdtempSync(join(tmpdir(), 'fanout-mcp-')), 'clip.mp4');
    const caller = (postWithoutPreview: boolean) => {
      const mcp = new McpServer({ ctx: env.ctx, providers: providerMap(), probe: async (path) => ({ ...fakeMedia({ durationSec: 20 }), path }), worker: { tick() {} } as never, postWithoutPreview });
      return async (name: string, args: Record<string, unknown>) =>
        ((await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as { result: { isError?: boolean; structuredContent: any; content: Array<{ text: string }> } }).result;
    };
    const call = caller(false);

    writeFileSync(video, 'x');
    process.env.FANOUT_LANG = 'en';
    try {
      const missing = await call('get_post_status', { postId: 'nope' });
      assert.equal(missing.isError, true);
      assert.equal(missing.content[0]!.text, 'No such post: nope');
      const preview = await call('preview_post', { path: video, title: '제목을 입력하세요', targets: [{ platform: 'youtube' }, { platform: 'instagram' }] });
      const [yt, ig] = preview.structuredContent.targets;
      assert.ok(yt.errors.some((e: string) => /YouTube visibility/.test(e)), JSON.stringify(yt.errors));
      assert.ok(ig.errors.every((e: string) => !/[가-힣]/.test(e)), JSON.stringify(ig.errors));
      assert.ok(!/[가-힣]/.test(preview.content[0]!.text.replaceAll('제목을 입력하세요', '')));
      const unseen = await call('create_post', { path: video, title: 'T', targets: [{ platform: 'youtube' }] });
      assert.match(unseen.content[0]!.text, /^No previewId\. Call preview_post first/);
      const bad = await caller(true)('create_post', { path: video, title: 'T', targets: [{ platform: 'youtube' }] });
      assert.match(bad.content[0]!.text, /^Not posted: some targets can't be posted:\n- youtube\/main: /);
      assert.doesNotMatch(bad.content[0]!.text, /[가-힣]/);
    } finally {
      delete process.env.FANOUT_LANG;
    }
    const ko = await call('get_post_status', { postId: 'nope' });
    assert.equal(ko.content[0]!.text, '게시물 없음: nope');
  });
});
