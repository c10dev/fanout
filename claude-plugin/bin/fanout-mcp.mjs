#!/usr/bin/env node
// Starts `fanout mcp` for the Claude Code plugin. When fanout is not installed, it answers the MCP
// handshake with an error that says how to install it. Claude Code shows that error in /mcp; for a
// plugin whose command is missing it shows only `Executable not found in $PATH: "stdio"`.
import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';

const INSTALL = 'npm install -g --allow-git=all github:c10dev/fanout';
const WINDOWS = process.platform === 'win32';

/** The fanout command on the PATH (fanout.cmd and the like on Windows), or undefined. */
function findFanout() {
  const exts = WINDOWS ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = join(dir, 'fanout' + ext);
      try {
        if (!statSync(file).isFile()) continue;
        if (!WINDOWS) accessSync(file, constants.X_OK);
        return file;
      } catch {
        // not in this folder
      }
    }
  }
  return undefined;
}

/** Answer every request with the install instructions, so the client shows them, until input ends. */
function explainInstall() {
  // Plain text: Claude Code shows it as is, and the docs quote it.
  const text =
    'fanout is not installed: there is no fanout command on the PATH that Claude Code runs with. ' +
    `Install it with: ${INSTALL} (Node.js 24+ and ffmpeg are needed), and check it with: fanout version. ` +
    'Then reconnect plugin:fanout:fanout in /mcp, or restart Claude Code.';
  process.stderr.write(text + '\n');
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    // Notifications (no id) get no answer.
    if (!req || typeof req !== 'object' || req.id === undefined || req.id === null) return;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: text } }) + '\n');
  });
}

const fanout = findFanout();
if (!fanout) {
  explainInstall();
} else {
  // stdin and stdout go straight to fanout. This process only waits for it and passes signals on.
  // On Windows, npm installs fanout.cmd, which only a shell can run; cmd finds it on the PATH again.
  const child = WINDOWS && /\.(bat|cmd)$/i.test(fanout)
    ? spawn('fanout', ['mcp'], { stdio: 'inherit', shell: true })
    : spawn(fanout, ['mcp'], { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.on('error', (err) => {
    process.stderr.write(`fanout-mcp: ${err.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code ?? 1));
}
