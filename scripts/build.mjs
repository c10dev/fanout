// Compile src/ to dist/ and copy the dashboard's static files next to the compiled server.
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, realpathSync, rmSync, writeFileSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' });
cpSync('src/server/public', 'dist/server/public', { recursive: true });
chmodSync('dist/cli.js', 0o755);
// The commit this build is from, for `fanout version`, when it is built in fanout's own checkout
// (not a tarball that happens to sit inside some other repository, e.g. a home folder under git).
try {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (realpathSync(git('rev-parse', '--show-toplevel')) === realpathSync(process.cwd())) {
    const commit = git('rev-parse', '--short', 'HEAD');
    if (commit) writeFileSync('dist/commit.txt', commit + '\n');
  }
} catch {
  // not a git checkout: the version alone (npm's gitHead may still say, see cli.ts buildCommit)
}
console.log('built dist/');
