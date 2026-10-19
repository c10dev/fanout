import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, FANOUT_LANG: 'en', FANOUT_HOME: mkdtempSync(join(tmpdir(), 'fanout-cli-')), ...env }, encoding: 'utf8' });

describe('CLI basics', () => {
  it('prints the installed version', () => {
    const { version } = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string };
    for (const args of [['version'], ['--version']]) {
      const r = run(args);
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trim(), `fanout ${version}`);
    }
  });

  it('refuses a dashboard token shorter than 16 characters', () => {
    const r = run(['serve', '--host', '0.0.0.0', '--port', '0'], { FANOUT_DASHBOARD_TOKEN: 'short' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /at least 16 characters/);
  });
});
