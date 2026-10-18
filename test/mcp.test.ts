import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { McpServer } from '../src/mcp/server.ts';
import { providerMap } from '../src/providers/index.ts';
import { fakeMedia, makeCtx } from './helpers.ts';

function server() {
  const env = makeCtx();
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
  });
  let id = 0;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await mcp.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })) as {
      result: { isError?: boolean; structuredContent: Record<string, any>; content: Array<{ text: string }> };
    };
    return res.result;
  };
  return { env, mcp, video, call, ticks: () => ticks };
}

describe('MCP server', () => {
  it('negotiates the protocol version and lists tools', async () => {
    const { mcp } = server();
    const init = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01' } })) as { result: { protocolVersion: string; capabilities: unknown } };
    assert.equal(init.result.protocolVersion, '2025-11-25', 'unknown version → latest supported');
    assert.deepEqual(init.result.capabilities, { tools: {} });
    assert.equal(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
    const list = (await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as { result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> } };
    const tools = Object.fromEntries(list.result.tools.map((t) => [t.name, t.annotations.readOnlyHint]));
    assert.deepEqual(tools, { list_accounts: true, check_video: true, preview_post: true, create_post: false, get_post_status: true, get_post_stats: true, get_limits: true, get_post_comments: true, update_post: false, reply_to_comment: false, hide_comment: false, set_visibility: false, cancel_target: false, retry_target: false, add_to_post: false });
    const missing = (await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'nope' })) as { error: { code: number } };
    assert.equal(missing.error.code, -32601);
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

  it('refuses to create a post with blocking issues, then creates a valid one', async () => {
    const { call, video, env, ticks } = server();
    const bad = await call('create_post', { path: video, title: 'T', targets: [{ platform: 'youtube' }] });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0]!.text, /게시하지 않았습니다/);
    assert.equal(env.store.listPosts().length, 0);

    const ok = await call('create_post', {
      path: video,
      title: 'T',
      aiGenerated: true,
      targets: [{ platform: 'youtube', options: { privacy: 'unlisted', madeForKids: false } }],
    });
    assert.equal(ok.isError, undefined);
    assert.equal(ticks(), 1, 'kicks the worker');
    const postId = ok.structuredContent.postId as string;
    assert.equal(env.store.getPost(postId)?.containsSyntheticMedia, true);

    const status = await call('get_post_status', { postId: postId.slice(0, 8) });
    assert.equal(status.structuredContent.posts[0].targets[0].state, 'queued');
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
