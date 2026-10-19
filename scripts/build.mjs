// Compile src/ to dist/ and copy the dashboard's static files next to the compiled server.
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, rmSync, writeFileSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' });
cpSync('src/server/public', 'dist/server/public', { recursive: true });
chmodSync('dist/cli.js', 0o755);
// The commit this build is from, for `fanout version` (a git install builds in a clone).
try {
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (commit) writeFileSync('dist/commit.txt', commit + '\n');
} catch {
  // not a git checkout: the version alone
}
console.log('built dist/');
