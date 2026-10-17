import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SecretBox } from './crypto.ts';

export class RestoreError extends Error {}

export interface RestoreResult {
  posts: number;
  accounts: number;
  /** Where the data that was there before went. */
  savedTo?: string;
  /** The backup's key was put in place (false: FANOUT_SECRET_KEY or the existing key is used). */
  keyRestored: boolean;
}

const DB_FILES = ['fanout.db', 'fanout.db-wal', 'fanout.db-shm'];

function readOnly(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true });
}

/**
 * Put a `fanout backup` folder back as the data in `home`. Checks first that the backup is a sound
 * fanout database and that its tokens open with the key that will be in use, refuses while another
 * fanout process is working (unexpired leases), and moves whatever was in `home` aside instead of
 * deleting it. Must run with no database open on `home`.
 */
export function restoreBackup(opts: { home: string; backupDir: string; now: Date; envKey?: string; force?: boolean }): RestoreResult {
  const { home, backupDir, now } = opts;
  const backupDb = join(backupDir, 'fanout.db');
  if (!existsSync(backupDb)) throw new RestoreError(`${backupDir} 에 fanout.db 가 없습니다. fanout backup 으로 만든 fanout-<시각> 폴더를 지정하세요`);

  // 1. The backup must be an intact fanout database.
  let posts = 0;
  let accounts = 0;
  let sealed: string | undefined;
  const db = readOnly(backupDb);
  try {
    const ok = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
    if (ok !== 'ok') throw new RestoreError(`백업 DB가 손상됐습니다: ${ok}`);
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name));
    for (const t of ['posts', 'targets', 'accounts', 'apps']) if (!tables.has(t)) throw new RestoreError(`fanout 백업이 아닙니다 (${t} 테이블 없음)`);
    posts = (db.prepare('SELECT count(*) AS n FROM posts').get() as { n: number }).n;
    accounts = (db.prepare('SELECT count(*) AS n FROM accounts').get() as { n: number }).n;
    sealed = (db.prepare('SELECT credentials FROM accounts LIMIT 1').get() as { credentials: string } | undefined)?.credentials;
  } finally {
    db.close();
  }

  // 2. Its tokens must open with the key that will be used afterwards.
  const backupKey = join(backupDir, 'secret.key');
  const homeKey = join(home, 'secret.key');
  const keyText = opts.envKey ?? (existsSync(backupKey) ? readFileSync(backupKey, 'utf8') : existsSync(homeKey) ? readFileSync(homeKey, 'utf8') : undefined);
  if (sealed) {
    if (!keyText) throw new RestoreError('백업에 secret.key 가 없고 FANOUT_SECRET_KEY 도 없어 저장된 토큰을 풀 수 없습니다');
    try {
      new SecretBox(Buffer.from(keyText.trim(), 'base64')).open(sealed);
    } catch {
      throw new RestoreError(
        opts.envKey ? 'FANOUT_SECRET_KEY 로 백업의 토큰을 풀 수 없습니다. 백업할 때의 키를 지정하세요' : '백업의 토큰을 풀 수 있는 키가 없습니다 (백업의 secret.key 를 확인하세요)',
      );
    }
  }

  // 3. Nobody may be working on the current data.
  const currentDb = join(home, 'fanout.db');
  if (existsSync(currentDb) && !opts.force) {
    const cur = readOnly(currentDb);
    try {
      const busy = cur.prepare('SELECT count(*) AS n FROM targets WHERE lease_until > ?').get(now.toISOString()) as { n: number } | undefined;
      if (busy && busy.n > 0) throw new RestoreError(`다른 fanout 프로세스가 작업 중입니다 (대상 ${busy.n}개). 대시보드·worker·watch·mcp 를 모두 끈 뒤 다시 하세요 (--force 로 무시)`);
    } catch (err) {
      if (err instanceof RestoreError) throw err;
      // An old database without lease columns can't be busy in that sense.
    } finally {
      cur.close();
    }
  }

  // 4. Move the current data aside, then put the backup in place.
  mkdirSync(home, { recursive: true, mode: 0o700 });
  let savedTo: string | undefined;
  const present = [...DB_FILES, ...(existsSync(backupKey) && !opts.envKey ? ['secret.key'] : [])].filter((f) => existsSync(join(home, f)));
  if (present.length) {
    savedTo = join(home, `before-restore-${now.toISOString().replace(/[:.]/g, '-')}`);
    mkdirSync(savedTo, { recursive: true, mode: 0o700 });
    for (const f of present) renameSync(join(home, f), join(savedTo, f));
  }
  copyFileSync(backupDb, currentDb);
  chmodSync(currentDb, 0o600);
  const keyRestored = existsSync(backupKey) && !opts.envKey;
  if (keyRestored) {
    copyFileSync(backupKey, homeKey);
    chmodSync(homeKey, 0o600);
  }
  return { posts, accounts, savedTo, keyRestored };
}
