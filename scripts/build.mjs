// Compile src/ to dist/ and copy the dashboard's static files next to the compiled server.
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' });
cpSync('src/server/public', 'dist/server/public', { recursive: true });
chmodSync('dist/cli.js', 0o755);
console.log('built dist/');
