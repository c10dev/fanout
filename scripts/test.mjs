// Runs the test suite with a temp folder of its own (TMPDIR), removed afterwards: tests make
// fixtures with mkdtemp and don't clean up one by one, which piled up tens of thousands of folders.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'fanout-tests-'));
const files = process.argv.slice(2);
const run = spawnSync(process.execPath, ['--test', ...(files.length ? files : ['test/**/*.test.ts'])], {
  stdio: 'inherit',
  env: { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir },
});
rmSync(dir, { recursive: true, force: true });
process.exit(run.status ?? 1);
