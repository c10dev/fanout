// Runs the test suite with a temp folder of its own (TMPDIR), removed afterwards: tests make
// fixtures with mkdtemp and don't clean up one by one, which piled up tens of thousands of folders.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'fanout-tests-'));
// Test files given after "npm test --"; anything starting with "-" goes to node --test as a flag.
const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('-'));
const flags = args.filter((a) => a.startsWith('-'));
// Ctrl-C reaches the test run too; staying alive here lets the cleanup below still happen.
process.on('SIGINT', () => {});
const run = spawnSync(process.execPath, ['--test', ...flags, ...(files.length ? files : ['test/**/*.test.ts'])], {
  stdio: 'inherit',
  env: { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir },
});
try {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
} catch (err) {
  console.error(`could not remove ${dir}: ${err.message}`);
}
if (run.error) console.error(run.error.message);
process.exit(run.status ?? 1);
