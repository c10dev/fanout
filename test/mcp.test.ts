import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { mcpRoots } from '../src/cli.ts';
import { makeTestClip } from '../src/core/media.ts';
import { McpServer } from '../src/mcp/server.ts';
import { providerMap } from '../src/providers/index.ts';
import { fakeMedia, makeCtx } from './helpers.ts';

function server({ roots, postWithoutPreview, now }: { roots?: string[]; postWithoutPreview?: boolean; now?: () => Date } = {}) {
  const env = makeCtx(undefined, now);
  env.store.saveAccount({ platform: 'youtube', name: 'main', credentials: { secret: 'NOPE' }, profile: { channelTitle: 'C10' } });
  env.store.saveAccount({ platform: 'tiktok', name: 'mainmain', credentials: {}, profile: { displayName: 'c10e2' } });
  const video = join(mkdtempSync(join(tmpdir(), 'fanout-mcp-')), 'clip.mp4');
  writeFileSync(video, 'x');
  let ticks = 0;
  const mcp = new McpServer({
    ctx: env.ctx,
    providers: providerMap(),
    probe: async (path) => ({ ...fakeMedia({ durationSec: 20 }), path }),
    worker: { tick: () => ticks++ } as never,
    roots,
    postWithoutPreview,
  });
  let id = 0;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await mcp.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })) as {
      result: { isError?: boolean; structuredContent: Record<string, any>; content: Array<{ text: string }> };
    };
    return res.result;
  };
  /** preview_post, then create_post with the previewId it gave, as after the user's yes. */
  const post = async (args: Record<string, unknown>) => {
    const preview = await call('preview_post', args);
    return call('create_post', { ...args, previewId: preview.structuredContent?.previewId });
  };
  return { env, mcp, video, call, post, ticks: () => ticks };
}

const YT = { platform: 'youtube', options: { privacy: 'unlisted', madeForKids: false } };

describe('MCP server', () => {
  it('negotiates the protocol version and lists tools', async () => {
    const { mcp } = server();
    const init = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01' } })) as { result: { protocolVersion: string; capabilities: unknown } };
    assert.equal(init.result.protocolVersion, '2025-11-25', 'unknown version → latest supported');
    assert.deepEqual(init.result.capabilities, { tools: {} });
    assert.equal(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
    const list = (await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as { result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> } };
    const tools = Object.fromEntries(list.result.tools.map((t) => [t.name, t.annotations.readOnlyHint]));
    assert.deepEqual(tools, { list_accounts: true, check_video: true, preview_post: true, create_post: false, get_post_status: true, get_post_stats: true, get_calendar: true, get_comment_inbox: true, get_insights: true, suggest_post_times: true, get_limits: true, get_post_comments: true, update_post: false, reply_to_comment: false, hide_comment: false, set_visibility: false, cancel_target: false, retry_first_comment: false, retry_target: false, add_to_post: false });
    const byName = Object.fromEntries((list.result.tools as unknown as Array<{ name: string; annotations: Record<string, boolean>; inputSchema: { required?: string[] } }>).map((t) => [t.name, t]));
    // preview_post asks the platforms (limits, TikTok creator_info); edits and cancels can't be undone.
    assert.equal(byName.preview_post!.annotations.openWorldHint, true);
    assert.equal(byName.update_post!.annotations.destructiveHint, true);
    assert.equal(byName.cancel_target!.annotations.destructiveHint, true);
    assert.ok(byName.create_post!.inputSchema.required!.includes('previewId'));
    assert.ok(!byName.preview_post!.inputSchema.required!.includes('previewId'));
    const missing = (await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'nope' })) as { error: { code: number } };
    assert.equal(missing.error.code, -32601);
  });

  it('names exactly the platforms whose capabilities take the AI label, a thumbnail or captions', async () => {
    // An extra provider shows the text comes from the providers the server runs with.
    const clip = { ...providerMap().get('bluesky')!, id: 'clip', displayName: 'Clip', capabilities: { nativeSchedule: false, thumbnail: true, captions: true, syntheticMediaFlag: true } };
    const providers = providerMap([clip]);
    const mcp = new McpServer({ ctx: makeCtx().ctx, providers });
    const list = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as { result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, { description: string }> } }> } };
    for (const tool of ['preview_post', 'create_post']) {
      const props = list.result.tools.find((t) => t.name === tool)!.inputSchema.properties;
      for (const [field, cap] of [['aiGenerated', 'syntheticMediaFlag'], ['thumbnailPath', 'thumbnail'], ['captions', 'captions']] as const) {
        for (const p of providers.values()) assert.equal(props[field]!.description.includes(p.displayName), p.capabilities[cap], `${tool} ${field}: ${p.id}`);
      }
    }
  });

  it('lists accounts without credentials', async () => {
    const { call } = server();
    const r = await call('list_accounts');
    assert.ok(!JSON.stringify(r).includes('NOPE'));
    const yt = r.structuredContent.platforms.find((p: { platform: string }) => p.platform === 'youtube');
    assert.deepEqual(yt.accounts, [{ name: 'main', label: 'C10' }]);
  });

  it('previews a post with account labels, visibility and required choices', async () => {
    const { call, video } = server();
    const r = await call('preview_post', { path: video, title: 'T', targets: [{ platform: 'youtube' }, { platform: 'tiktok' }, { platform: 'instagram' }] });
    const [yt, tt, ig] = r.structuredContent.targets;
    assert.equal(yt.accountLabel, 'C10');
    assert.ok(yt.errors.some((e: string) => e.includes('공개 범위')));
    assert.equal(tt.account, 'mainmain', 'defaults to the only connected account');
    assert.equal(tt.visibility, 'inbox (TikTok 앱에서 마무리)');
    assert.deepEqual(tt.errors, []);
    assert.ok(ig.errors.some((e: string) => e.includes('연결되지 않은 계정')));
  });

  it('posts only what a preview in this server showed, once', async () => {
    const { call, video, env, ticks } = server();
    const args = { path: video, title: 'T', aiGenerated: true, targets: [YT] };
    // A fresh server has shown nothing, so nothing is posted.
    const unseen = await call('create_post', args);
    assert.equal(unseen.isError, true);
    assert.match(unseen.content[0]!.text, /previewId/);
    assert.equal((await call('create_post', { ...args, previewId: 'made-up' })).isError, true);
    // A preview with errors gets no id: it can't be posted.
    const bad = await call('preview_post', { path: video, title: 'T', targets: [{ platform: 'youtube' }] });
    assert.ok(bad.structuredContent.targets[0].errors.length);
    assert.equal(bad.structuredContent.previewId, undefined);
    assert.equal(env.store.listPosts().length, 0);

    const preview = await call('preview_post', args);
    const previewId = preview.structuredContent.previewId as string;
    assert.match(previewId, /^[\w-]{16}$/);
    assert.equal(preview.structuredContent.previewExpiresAt, '2026-10-17T03:30:00.000Z');
    // Fields in another order are the same post.
    const ok = await call('create_post', { targets: [{ options: { madeForKids: false, privacy: 'unlisted' }, platform: 'youtube' }], aiGenerated: true, title: 'T', path: video, previewId });
    assert.equal(ok.isError, undefined, ok.content[0]!.text);
    assert.equal(ticks(), 1, 'kicks the worker');
    const postId = ok.structuredContent.postId as string;
    assert.equal(env.store.getPost(postId)?.containsSyntheticMedia, true);
    const status = await call('get_post_status', { postId: postId.slice(0, 8) });
    assert.equal(status.structuredContent.posts[0].targets[0].state, 'queued');

    // One yes, one post: the same preview can't post again.
    const again = await call('create_post', { ...args, previewId });
    assert.equal(again.isError, true);
    assert.equal(env.store.listPosts().length, 1);
  });

  it('refuses a preview of other arguments or one that expired, and keeps it when that is all', async () => {
    let at = Date.parse('2026-10-17T03:00:00Z');
    const { call, video, env } = server({ now: () => new Date(at) });
    const args = { path: video, title: 'T', targets: [YT] };
    const previewId = (await call('preview_post', args)).structuredContent.previewId as string;
    for (const changed of [{ title: 'T2' }, { description: 'more' }, { scheduledAt: '2026-10-18T00:00:00Z' }, { targets: [{ ...YT, options: { ...YT.options, privacy: 'public' } }] }, { targets: [YT, { platform: 'tiktok' }] }]) {
      const r = await call('create_post', { ...args, ...changed, previewId });
      assert.equal(r.isError, true, JSON.stringify(changed));
      assert.match(r.content[0]!.text, /미리보기와 다릅니다/);
    }
    // The video itself changed since the preview.
    writeFileSync(video, 'y');
    assert.match((await call('create_post', { ...args, previewId })).content[0]!.text, /미리보기와 다릅니다/);
    writeFileSync(video, 'x');
    at += 31 * 60_000;
    const late = await call('create_post', { ...args, previewId });
    assert.equal(late.isError, true);
    assert.match(late.content[0]!.text, /만료/);
    assert.equal(env.store.listPosts().length, 0);
  });

  it('takes posts without a preview only when the server runs with --post-without-preview', async () => {
    const { call, video, env, mcp } = server({ postWithoutPreview: true });
    const list = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as { result: { tools: Array<{ name: string; description: string; inputSchema: { required: string[] } }> } };
    assert.ok(!list.result.tools.find((t) => t.name === 'create_post')!.inputSchema.required.includes('previewId'));
    // The agent isn't told about a check that is off.
    for (const t of list.result.tools) assert.doesNotMatch(t.description, /refused (without|unless)/i, t.name);
    const init = (await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} })) as { result: { instructions: string } };
    assert.doesNotMatch(init.result.instructions, /needs the previewId/);
    const on = server().mcp;
    const onList = (await on.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as typeof list;
    for (const name of ['create_post', 'add_to_post', 'update_post']) assert.match(onList.result.tools.find((t) => t.name === name)!.description, /refused (without|unless)/i, name);
    assert.match(((await on.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} })) as typeof init).result.instructions, /needs the previewId/);
    // Errors still block the post.
    const bad = await call('create_post', { path: video, title: 'T', targets: [{ platform: 'youtube' }] });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0]!.text, /게시하지 않았습니다/);
    assert.equal(env.store.listPosts().length, 0);
    assert.equal((await call('create_post', { path: video, title: 'T', targets: [YT] })).isError, undefined);
    assert.equal(env.store.listPosts().length, 1);
  });

  it('matches a preview with thumbnailAt to its post (the frame is made again)', async () => {
    const { post, env } = server();
    const clip = join(realpathSync(mkdtempSync(join(tmpdir(), 'fanout-mcp-clip-'))), 'clip.mp4');
    await makeTestClip(clip, 2);
    const r = await post({ path: clip, title: 'T', thumbnailAt: 1, targets: [YT] });
    assert.equal(r.isError, undefined, r.content[0]!.text);
    assert.ok(env.store.getPost(r.structuredContent.postId)!.thumbnailPath!.startsWith(join(env.ctx.home, 'media')));
  });

  it('adds platforms to a post only after a dry run of exactly those targets', async () => {
    const { call, post, env, ticks, video } = server();
    const made = await post({ path: video, title: 'T', targets: [YT] });
    const postId = made.structuredContent.postId as string;
    const tiktok = [{ platform: 'tiktok' }];
    const unseen = await call('add_to_post', { postId, targets: tiktok });
    assert.equal(unseen.isError, true);
    assert.match(unseen.content[0]!.text, /previewId/);
    const dry = await call('add_to_post', { postId, targets: tiktok, dryRun: true });
    const previewId = dry.structuredContent.previewId as string;
    assert.ok(previewId);
    assert.equal(env.store.targetsForPost(postId).length, 1, 'a dry run adds nothing');
    assert.match((await call('add_to_post', { postId, targets: [{ platform: 'tiktok', options: { mode: 'direct' } }], previewId })).content[0]!.text, /미리보기와 다릅니다/);
    const added = await call('add_to_post', { postId, targets: tiktok, previewId });
    assert.equal(added.isError, undefined, added.content[0]!.text);
    assert.equal(env.store.targetsForPost(postId).length, 2);
    assert.equal(ticks(), 2);
    assert.equal((await call('add_to_post', { postId, targets: tiktok, previewId })).isError, true, 'used once');
  });

  it('refuses an add_to_post dry run once the post itself changed', async () => {
    const { call, post, video, env } = server();
    const postId = (await post({ path: video, title: 'T', targets: [YT] })).structuredContent.postId as string;
    const tiktok = [{ platform: 'tiktok' }];
    const previewId = (await call('add_to_post', { postId, targets: tiktok, dryRun: true })).structuredContent.previewId;
    // The text the new target would upload changes after the dry run (as update_post would do).
    env.store.updatePost(postId, { title: 'Changed' });
    const r = await call('add_to_post', { postId, targets: tiktok, previewId });
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /미리보기와 다릅니다/);
    assert.equal(env.store.targetsForPost(postId).length, 1);
  });

  it('edits a post whose targets have not gone out only after a dry run of that edit', async () => {
    const { call, post, video, env } = server();
    const postId = (await post({ path: video, title: 'Approved', scheduledAt: '2026-10-25T09:00:00Z', targets: [{ platform: 'youtube', options: { privacy: 'public', madeForKids: false } }] })).structuredContent.postId as string;
    // The scheduled target would upload this text: no edit without a preview.
    const unseen = await call('update_post', { postId, title: 'Unapproved' });
    assert.equal(unseen.isError, true);
    assert.match(unseen.content[0]!.text, /previewId/);
    assert.equal(env.store.getPost(postId)!.title, 'Approved', 'the record is untouched');

    const dry = await call('update_post', { postId, title: 'New', dryRun: true });
    assert.deepEqual(dry.structuredContent.changes, { title: { from: 'Approved', to: 'New' } });
    assert.deepEqual(dry.structuredContent.uploadsWithNewText.map((t: { platform: string; state: string }) => `${t.platform}:${t.state}`), ['youtube:queued']);
    assert.equal(env.store.getPost(postId)!.title, 'Approved', 'a dry run changes nothing');
    const previewId = dry.structuredContent.previewId as string;
    assert.match((await call('update_post', { postId, title: 'Other', previewId })).content[0]!.text, /미리보기와 다릅니다/);
    const ok = await call('update_post', { postId, title: 'New', previewId });
    assert.equal(ok.isError, undefined, ok.content[0]!.text);
    assert.equal(env.store.getPost(postId)!.title, 'New');
    assert.equal((await call('update_post', { postId, title: 'New', previewId })).isError, true, 'used once');
  });

  it('counts a failed target as not gone out, so an edit before retry_target needs a preview', async () => {
    const { call, post, video, env } = server();
    const postId = (await post({ path: video, title: 'Approved', targets: [YT] })).structuredContent.postId as string;
    const target = env.store.targetsForPost(postId)[0]!;
    env.store.transition(target.id, 'failed', { errorCode: 'x' });
    assert.equal((await call('update_post', { postId, title: 'After failure' })).isError, true);
    assert.equal(env.store.getPost(postId)!.title, 'Approved');
  });

  it('edits a post that is only live without a preview (the description asks the user)', async () => {
    const { call, env } = server();
    const { post: made, targets } = env.store.createPost({ mediaPath: '/v.mp4', title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false }, [{ platform: 'youtube', account: 'main', options: {} }]);
    env.store.transition(targets[0]!.id, 'uploading');
    env.store.transition(targets[0]!.id, 'published', { remoteId: 'VID' });
    const r = await call('update_post', { postId: made.id, title: 'Live edit' });
    assert.equal(r.isError, undefined, r.content[0]!.text);
    assert.equal(env.store.getPost(made.id)!.title, 'Live edit');
  });

  it('binds a preview to the thumbnail and caption contents, not only their paths', async () => {
    const { call, env } = server();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fanout-mcp-files-')));
    const video = join(dir, 'clip.mp4');
    const thumb = join(dir, 'cover.jpg');
    const subs = join(dir, 'ko.srt');
    writeFileSync(video, 'x');
    writeFileSync(thumb, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
    writeFileSync(subs, '1\n00:00:00,000 --> 00:00:01,000\napproved line\n');
    const args = { path: video, title: 'T', thumbnailPath: thumb, captions: [{ language: 'ko', path: subs }], targets: [YT] };
    let previewId = (await call('preview_post', args)).structuredContent.previewId;
    writeFileSync(subs, '1\n00:00:00,000 --> 00:00:01,000\nUNAPPROVED line\n');
    assert.match((await call('create_post', { ...args, previewId })).content[0]!.text, /미리보기와 다릅니다/);
    previewId = (await call('preview_post', args)).structuredContent.previewId;
    writeFileSync(thumb, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 1, 1, 1]));
    assert.match((await call('create_post', { ...args, previewId })).content[0]!.text, /미리보기와 다릅니다/);
    assert.equal(env.store.listPosts().length, 0);
  });

  it('retries only failed targets', async () => {
    const { call, env } = server();
    const { targets } = env.store.createPost({ mediaPath: '/v.mp4', title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false }, [{ platform: 'youtube', account: 'main', options: {} }]);
    const id = targets[0]!.id;
    assert.equal((await call('retry_target', { targetId: id })).isError, true);
    env.store.transition(id, 'failed', { errorCode: 'x' });
    const r = await call('retry_target', { targetId: id });
    assert.equal(r.structuredContent.target.state, 'queued');
  });

  it('holds a target that may already be posted until the user vouches for it', async () => {
    const { call, env } = server();
    const { targets } = env.store.createPost({ mediaPath: '/v.mp4', title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false }, [{ platform: 'x', account: 'main', options: {} }]);
    const id = targets[0]!.id;
    env.store.transition(id, 'uploading');
    env.store.transition(id, 'failed', { errorCode: 'x.maybe_posted', resume: { mediaId: 'M1', posting: true } });
    const held = await call('retry_target', { targetId: id });
    assert.equal(held.isError, true);
    assert.match(JSON.stringify(held.content), /confirmedNotPosted: true/);
    assert.equal(env.store.getTarget(id)!.state, 'failed');
    const ok = await call('retry_target', { targetId: id, confirmedNotPosted: true });
    assert.equal(ok.structuredContent.target.state, 'queued');
  });

  it('reports bad paths as tool errors, not protocol errors', async () => {
    const { call } = server();
    const r = await call('check_video', { path: '/definitely/not/here.mp4' });
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /파일이 없습니다/);
  });

  it('speaks newline-delimited JSON-RPC on stdout and nothing else', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fanout-mcp-home-'));
    const child = spawn(process.execPath, ['src/cli.ts', 'mcp'], { env: { ...process.env, FANOUT_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n');
    child.stdin.write('not json\n');
    child.stdin.end('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_accounts","arguments":{}}}\n');
    const code = await new Promise((r) => child.on('close', r));
    assert.equal(code, 0);
    const lines = out.trim().split('\n').map((l) => JSON.parse(l) as { id: number | null; error?: { code: number } });
    assert.deepEqual(lines.map((l) => l.id).sort(), [1, 2, null].sort());
    assert.equal(lines.find((l) => l.id === null)?.error?.code, -32700);
  });

  it('needs a preview unless started with --post-without-preview or FANOUT_MCP_POST_WITHOUT_PREVIEW=1', async () => {
    const { FANOUT_MCP_POST_WITHOUT_PREVIEW: _, ...env } = process.env;
    const required = async (flags: string[], extra: Record<string, string> = {}) => {
      const home = mkdtempSync(join(tmpdir(), 'fanout-mcp-home-'));
      const child = spawn(process.execPath, ['src/cli.ts', 'mcp', ...flags], { env: { ...env, FANOUT_HOME: home, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stdin.end('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
      await new Promise((r) => child.on('close', r));
      const tools = (JSON.parse(out) as { result: { tools: Array<{ name: string; inputSchema: { required: string[] } }> } }).result.tools;
      return tools.find((t) => t.name === 'create_post')!.inputSchema.required.includes('previewId');
    };
    assert.equal(await required([]), true);
    assert.equal(await required(['--post-without-preview']), false);
    assert.equal(await required([], { FANOUT_MCP_POST_WITHOUT_PREVIEW: '1' }), false);
    assert.equal(await required(['--post-without-preview', 'no'], { FANOUT_MCP_POST_WITHOUT_PREVIEW: '1' }), true, 'the flag wins');
    // A word the flag doesn't take is refused, not read as "on" with a stray word.
    for (const word of ['off', 'maybe']) {
      const home = mkdtempSync(join(tmpdir(), 'fanout-mcp-home-'));
      const child = spawn(process.execPath, ['src/cli.ts', 'mcp', '--post-without-preview', word], { env: { ...env, FANOUT_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.stdin.end('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
      const code = await new Promise((r) => child.on('close', r));
      assert.notEqual(code, 0, word);
      assert.equal(out, '', 'serves nothing');
      assert.ok(err.includes(word), err);
    }
  });

  it('answers in English unless FANOUT_LANG asks for Korean', async () => {
    const { FANOUT_LANG: _, ...env } = process.env;
    const ask = async (lang?: string) => {
      const home = mkdtempSync(join(tmpdir(), 'fanout-mcp-home-'));
      const child = spawn(process.execPath, ['src/cli.ts', 'mcp'], { env: { ...env, FANOUT_HOME: home, ...(lang ? { FANOUT_LANG: lang } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stdin.end('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_post_status","arguments":{"postId":"nope"}}}\n');
      await new Promise((r) => child.on('close', r));
      return (JSON.parse(out) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
    };
    assert.equal(await ask(), 'No such post: nope');
    assert.equal(await ask('ko'), '게시물 없음: nope');
    assert.equal(await ask('en'), 'No such post: nope');
  });
});

describe('MCP file access limited to chosen folders', () => {
  it('reads inside the allowed folders only, symlinks resolved first', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'fanout-mcp-roots-')));
    const allowed = join(base, 'videos');
    mkdirSync(allowed);
    const inside = join(allowed, 'clip.mp4');
    const outside = join(base, 'secret.mp4');
    const sneaky = join(allowed, 'link.mp4');
    writeFileSync(inside, 'x');
    writeFileSync(outside, 'x');
    symlinkSync(outside, sneaky);
    const { call } = server({ roots: [allowed] });
    assert.ok(!(await call('check_video', { path: inside })).isError);
    // One answer for "outside" and "not there", so an agent can't probe what exists elsewhere.
    for (const path of [outside, sneaky, join(allowed, '..', 'secret.mp4'), join(base, 'nothing.mp4')]) {
      const r = await call('check_video', { path });
      assert.ok(r.isError, path);
      assert.match(r.content[0]!.text, /no such file inside the allowed folders|허용된 폴더 안에 그 파일이 없습니다/);
    }
  });

  it('takes the folders from --allow or FANOUT_MCP_ROOTS, and refuses a missing one', () => {
    const a = realpathSync(mkdtempSync(join(tmpdir(), 'fanout-mcp-a-')));
    const b = realpathSync(mkdtempSync(join(tmpdir(), 'fanout-mcp-b-')));
    assert.deepEqual(mcpRoots(`${a},${b}`), [a, b]);
    assert.deepEqual(mcpRoots(undefined, `${a}:${b}`), [a, b]);
    assert.equal(mcpRoots(undefined, ''), undefined, 'unset: anywhere, as before');
    assert.throws(() => mcpRoots(join(a, 'nope')), /nope/);
    assert.deepEqual(mcpRoots('~'), [realpathSync(homedir())], 'a ~ the shell left alone');
    // "--allow" with nothing after it, or an empty value, must not mean "anywhere".
    assert.throws(() => mcpRoots(true), /--allow/);
    assert.throws(() => mcpRoots(''), /--allow/);
    assert.throws(() => mcpRoots(' , '), /--allow/);
  });
});

describe('MCP posts read fanout\'s own copies', () => {
  it('copies the thumbnail and captions at create_post, refusing links', async () => {
    const { env, call, post } = server();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fanout-mcp-assets-')));
    const video = join(dir, 'clip.mp4');
    const thumb = join(dir, 'cover.jpg');
    const subs = join(dir, 'ko.srt');
    writeFileSync(video, 'x');
    writeFileSync(thumb, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
    writeFileSync(subs, '1\n00:00:00,000 --> 00:00:01,000\nhi\n');
    const args = { path: video, title: 'T', targets: [{ platform: 'youtube', options: { privacy: 'unlisted', madeForKids: false } }] };
    const r = await post({ ...args, thumbnailPath: thumb, captions: [{ language: 'ko', path: subs }] });
    assert.ok(!r.isError, r.content[0]!.text);
    const made = env.store.getPost(r.structuredContent.postId)!;
    assert.ok(made.thumbnailPath!.startsWith(join(env.ctx.home, 'media')) && made.captions[0]!.path.startsWith(join(env.ctx.home, 'media')));
    const linked = join(dir, 'link.srt');
    symlinkSync(subs, linked);
    const withLink = { ...args, captions: [{ language: 'ko', path: linked }] };
    const previewId = (await call('preview_post', withLink)).structuredContent.previewId as string;
    const refused = await call('create_post', { ...withLink, previewId });
    assert.ok(refused.isError);
    assert.doesNotMatch(refused.content[0]!.text, /previewId/);
    // Nothing was posted, so the preview still stands: the same refusal again, not "unknown previewId".
    const again = await call('create_post', { ...withLink, previewId });
    assert.ok(again.isError);
    assert.doesNotMatch(again.content[0]!.text, /previewId/);
    assert.equal(env.store.listPosts().length, 1);
  });
});

describe('MCP account choice', () => {
  it('asks for an account when a platform has several and none is "main"', async () => {
    const { env, call, video } = server();
    env.store.saveAccount({ platform: 'tiktok', name: 'brand', credentials: {}, profile: {} });
    const r = await call('preview_post', { path: video, title: 'T', targets: [{ platform: 'tiktok' }] });
    assert.ok(r.isError);
    assert.match(r.content[0]!.text, /brand, mainmain/);
    assert.ok(!(await call('preview_post', { path: video, title: 'T', targets: [{ platform: 'tiktok', account: 'brand' }] })).isError);
  });
});
