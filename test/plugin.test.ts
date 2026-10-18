import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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

  it('starts the fanout MCP server', () => {
    const { mcpServers } = json('claude-plugin/.mcp.json');
    assert.deepEqual(Object.keys(mcpServers), ['fanout']);
    assert.equal(mcpServers.fanout.command, 'fanout');
    assert.deepEqual(mcpServers.fanout.args, ['mcp']);
    // FANOUT_LANG is left to the user's environment so FANOUT_LANG=ko still works.
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
