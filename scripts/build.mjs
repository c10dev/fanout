// Compile src/ to dist/ and copy the dashboard's static files next to the compiled server.
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, realpathSync, rmSync, writeFileSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' });
cpSync('src/server/public', 'dist/server/public', { recursive: true });
chmodSync('dist/cli.js', 0o755);
// The commit this build is from, for `fanout version`, when it is built in fanout's own checkout
// (not a tarball that happens to sit inside some other repository, e.g. a home folder under git).
let commit;
try {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (realpathSync(git('rev-parse', '--show-toplevel')) === realpathSync(process.cwd())) commit = git('rev-parse', '--short', 'HEAD');
} catch {
  // not a git checkout
}
// `npm install github:c10dev/fanout` builds from GitHub's tarball, which has no .git. The npm process
// that runs this build lists the git URLs it is preparing in _PACOTE_NO_PREPARE_, this package last,
// with the resolved commit after '#'. That variable is npm-internal, so use it only if it fits.
commit ||= /#([0-9a-f]{40})$/.exec(process.env._PACOTE_NO_PREPARE_?.split('\n').pop() ?? '')?.[1]?.slice(0, 7);
if (commit) writeFileSync('dist/commit.txt', commit + '\n');
console.log('built dist/');
