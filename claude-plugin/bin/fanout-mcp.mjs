#!/usr/bin/env node
// Starts `fanout mcp` for the Claude Code plugin. When fanout is not installed, or is too old to
// require a preview before posting, it answers the MCP handshake with an error that says what to
// do. Claude Code shows that error in /mcp; for a plugin whose command is missing it shows only
// `Executable not found in $PATH: "stdio"`.
import { spawn, spawnSync } from 'node:child_process';
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

// Plain text: Claude Code shows it as is, and the docs quote it.
const NOT_INSTALLED =
  'fanout is not installed: there is no fanout command on the PATH that Claude Code runs with. ' +
  `Install it with: ${INSTALL} (Node.js 24+ and ffmpeg are needed), and check it with: fanout version. ` +
  'Then reconnect plugin:fanout:fanout in /mcp, or restart Claude Code.';
const TOO_OLD =
  'This fanout is too old for the plugin: its MCP server posts without a preview first. ' +
  `Update it with: ${INSTALL}, and check it with: fanout version. ` +
  'Then reconnect plugin:fanout:fanout in /mcp, or restart Claude Code.';

/** Run fanout with these arguments, through a shell only for fanout.cmd and the like on Windows. */
function fanoutCommand(fanout, args) {
  return WINDOWS && /\.(bat|cmd)$/i.test(fanout)
    ? ['fanout', args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)), { shell: true }]
    : [fanout, args, {}];
}

/**
 * Why this fanout can't serve the plugin, or undefined. The plugin promises that a post needs a
 * preview first; builds from before that have no --post-without-preview in their help. A help that
 * doesn't run at all counts too: fanout mcp would not start either.
 */
function problem(fanout) {
  const [cmd, args, opts] = fanoutCommand(fanout, ['help']);
  const help = spawnSync(cmd, args, { ...opts, encoding: 'utf8', timeout: 25_000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (help.error || help.status !== 0) {
    return (
      `fanout help failed (${help.error?.message ?? `exit ${help.status}`}), so the plugin can't tell whether this fanout requires a preview before posting. ` +
      `Check it with: fanout help, and reinstall it with: ${INSTALL} if it fails. Then reconnect plugin:fanout:fanout in /mcp, or restart Claude Code.`
    );
  }
  return help.stdout.includes('--post-without-preview') ? undefined : TOO_OLD;
}

/** Answer every request with this text, so the client shows it, until input ends. */
function explain(text) {
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
const why = fanout ? problem(fanout) : NOT_INSTALLED;
if (why) {
  explain(why);
} else {
  // Arguments after the launcher's path in .mcp.json go to `fanout mcp` (e.g. --allow a,b).
  // stdin and stdout go straight to fanout. This process only waits for it and passes signals on.
  // On Windows, npm installs fanout.cmd, which only a shell can run; cmd finds it on the PATH again.
  const [cmd, args, opts] = fanoutCommand(fanout, ['mcp', ...process.argv.slice(2)]);
  const child = spawn(cmd, args, { ...opts, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.on('error', (err) => {
    process.stderr.write(`fanout-mcp: ${err.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code ?? 1));
}
