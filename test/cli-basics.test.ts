import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { openContext } from '../src/core/context.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, FANOUT_LANG: 'en', FANOUT_HOME: mkdtempSync(join(tmpdir(), 'fanout-cli-')), ...env }, encoding: 'utf8' });

describe('CLI basics', () => {
  it('prints the installed version', () => {
    const { version } = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string };
    for (const args of [['version'], ['--version']]) {
      const r = run(args);
      assert.equal(r.status, 0);
      // A checkout knows its commit (it tells main apart from the release with the same version);
      // a source archive without .git has just the version.
      const commit = existsSync(join(import.meta.dirname, '..', '.git')) ? ' \\([0-9a-f]{7,}\\)' : '';
      assert.match(r.stdout.trim(), new RegExp(`^fanout ${version.replace(/\./g, '\\.')}${commit}$`));
    }
  });

  it('takes the commit a build recorded, and has none without one', async () => {
    const { buildCommit } = await import('../src/cli.ts');
    const dir = mkdtempSync(join(tmpdir(), 'fanout-ver-'));
    const here = new URL(`file://${join(dir, 'dist')}/`);
    mkdirSync(join(dir, 'dist'));
    assert.equal(buildCommit(here), undefined, 'no record and no .git: the version alone');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ gitHead: 'def5678901234' }));
    assert.equal(buildCommit(here), 'def5678', "npm's gitHead for a git install");
    writeFileSync(join(dir, 'dist', 'commit.txt'), 'abc1234\n');
    assert.equal(buildCommit(here), 'abc1234');
  });

  it('retry refuses a platform it does not know instead of retrying everything', () => {
    const home = mkdtempSync(join(tmpdir(), 'fanout-cli-'));
    const ctx = openContext(home);
    const { post, targets: [t] } = ctx.store.createPost({ title: 't', mediaPath: '/x.mp4', description: '', tags: [], captions: [], containsSyntheticMedia: false }, [{ platform: 'youtube', account: 'main', options: {} }]);
    ctx.store.transition(t!.id, 'failed', { errorCode: 'youtube.maybe_posted', errorMessage: 'm' }, 'test');
    ctx.store.close();
    const r = run(['retry', post.id, 'youtub', '--confirmed-not-posted'], { FANOUT_HOME: home });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /youtub/);
    const after = openContext(home);
    assert.equal(after.store.getTarget(t!.id)!.state, 'failed', 'nothing retried');
    after.store.close();
  });

  it('retry --account retries that account only', () => {
    const home = mkdtempSync(join(tmpdir(), 'fanout-cli-'));
    const ctx = openContext(home);
    const { post, targets: [main, other] } = ctx.store.createPost({ title: 't', mediaPath: '/x.mp4', description: '', tags: [], captions: [], containsSyntheticMedia: false }, [
      { platform: 'youtube', account: 'main', options: {} },
      { platform: 'youtube', account: 'other', options: {} },
    ]);
    for (const t of [main!, other!]) ctx.store.transition(t.id, 'failed', { errorCode: 'youtube.quota', errorMessage: 'm' }, 'test');
    ctx.store.close();
    const r = run(['retry', post.id, 'youtube', '--account', 'other'], { FANOUT_HOME: home });
    assert.equal(r.status, 0, r.stderr);
    const after = openContext(home);
    assert.equal(after.store.getTarget(main!.id)!.errorCode, 'youtube.quota', 'the other account is left alone');
    assert.notEqual(after.store.getTarget(other!.id)!.errorCode, 'youtube.quota', 'tried again (it has no connection here, so it stops at needs_reauth)');
    after.store.close();
  });

  it('refuses a dashboard token shorter than 16 characters', () => {
    const r = run(['serve', '--host', '0.0.0.0', '--port', '0'], { FANOUT_DASHBOARD_TOKEN: 'short' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /at least 16 characters/);
  });
});
