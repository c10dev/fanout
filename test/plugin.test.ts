import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

// The Claude Code plugin (claude-plugin/) and the marketplace at the repository root that lists it.

const root = join(import.meta.dirname, '..');
const json = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, any>;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe('Claude Code plugin', () => {
  it('has a manifest that matches the package', () => {
    const plugin = json('claude-plugin/.claude-plugin/plugin.json');
    assert.match(plugin.name, KEBAB);
    assert.equal(plugin.name, 'fanout');
    assert.equal(plugin.version, json('package.json').version, 'bump claude-plugin/.claude-plugin/plugin.json with package.json');
    assert.equal(plugin.license, json('package.json').license);
    assert.ok(plugin.description?.length > 20);
  });

  it('starts the fanout MCP server through the launcher', () => {
    const { mcpServers } = json('claude-plugin/.mcp.json');
    assert.deepEqual(Object.keys(mcpServers), ['fanout']);
    assert.equal(mcpServers.fanout.command, 'node');
    assert.deepEqual(mcpServers.fanout.args, ['${CLAUDE_PLUGIN_ROOT}/bin/fanout-mcp.mjs']);
    assert.ok(existsSync(join(root, 'claude-plugin/bin/fanout-mcp.mjs')));
    // FANOUT_LANG and FANOUT_MCP_ROOTS are left to the user's environment.
    assert.equal(mcpServers.fanout.env, undefined);
  });

  it('is listed in the marketplace at the repository root', () => {
    const market = json('.claude-plugin/marketplace.json');
    assert.match(market.name, KEBAB);
    assert.ok(market.owner?.name);
    assert.equal(market.plugins.length, 1);
    for (const p of market.plugins) {
      assert.match(p.source, /^\.\//, 'relative sources start with ./');
      const dir = resolve(root, p.source);
      assert.ok(existsSync(join(dir, '.claude-plugin', 'plugin.json')), `${p.source} holds a plugin`);
      assert.equal(p.name, json(join(p.source, '.claude-plugin', 'plugin.json')).name);
    }
  });

  it('has a skill that asks before every post', () => {
    const skill = readFileSync(join(root, 'claude-plugin/skills/fanout-post/SKILL.md'), 'utf8');
    const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1];
    assert.ok(front, 'YAML frontmatter');
    assert.match(front, /^name: fanout-post$/m);
    assert.match(front, /^description: .{50,}$/m);
    // The safe order, and the rule that a post needs the user's yes every time.
    const order = ['check_video', 'preview_post', 'create_post', 'get_post_status'].map((tool) => skill.indexOf(`**\`${tool}\`**`));
    assert.ok(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1]!)), `flow in order: ${order}`);
    assert.match(skill, /public/i);
    assert.match(skill, /every single time/);
    assert.match(skill, /Never call `create_post` until the user has seen the `preview_post` result/);
    assert.doesNotMatch(skill, /[가-힣]/);
  });
});

/** Run the plugin's launcher with this PATH, write `input` to it, and collect what it prints. */
async function launch(path: string, input: string, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [join(root, 'claude-plugin/bin/fanout-mcp.mjs')], { env: { ...env, PATH: path }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  child.stdin.end(input);
  const code = await new Promise((r) => child.on('close', r));
  return { code, out, err };
}

describe('plugin launcher', { skip: process.platform === 'win32' && 'sh scripts' }, () => {
  it('answers every request with how to install fanout when it is not on the PATH', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'fanout-launcher-'));
    const { code, out, err } = await launch(
      empty,
      '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n' +
        '{"jsonrpc":"2.0","method":"notifications/initialized"}\n' +
        '{"jsonrpc":"2.0","id":"a","method":"tools/list"}\n',
    );
    assert.equal(code, 0);
    const lines = out.trim().split('\n').map((l) => JSON.parse(l) as { id: unknown; error: { code: number; message: string } });
    assert.deepEqual(lines.map((l) => l.id), [0, 'a'], 'one answer per request, none for the notification');
    for (const l of lines) {
      assert.equal(l.error.code, -32603);
      assert.match(l.error.message, /fanout is not installed/);
      assert.ok(l.error.message.includes('npm install -g --allow-git=all github:c10dev/fanout'));
      assert.match(l.error.message, /\/mcp/);
    }
    assert.match(err, /fanout is not installed/);
  });

  it('runs `fanout mcp` from the PATH with stdin, stdout and the environment passed through', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'fanout-launcher-'));
    const fake = join(bin, 'fanout');
    writeFileSync(fake, '#!/bin/sh\nprintf "args=%s lang=%s\\n" "$*" "$FANOUT_LANG"\nexec cat\n');
    chmodSync(fake, 0o755);
    const { code, out } = await launch(`${bin}:/usr/bin:/bin`, '{"jsonrpc":"2.0","id":1,"method":"ping"}\n', { FANOUT_LANG: 'ko' });
    assert.equal(code, 0);
    assert.equal(out, 'args=mcp lang=ko\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  });

  it('passes on the exit code of fanout', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'fanout-launcher-'));
    writeFileSync(join(bin, 'fanout'), '#!/bin/sh\nexit 3\n');
    chmodSync(join(bin, 'fanout'), 0o755);
    assert.equal((await launch(bin, '')).code, 3);
  });
});
