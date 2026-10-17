import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SecretBox } from './crypto.ts';
import { msg } from './i18n.ts';

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
 * Refuse while any other process has the current database open, even idle: it would keep writing
 * to the file we move aside. Switching the journal mode needs every other connection gone, so it
 * fails at once if one exists (and folds the WAL into the file, so moving it aside is complete).
 */
function assertNotInUse(path: string, now: Date, force?: boolean): void {
  if (!existsSync(path) || force) return;
  const db = new DatabaseSync(path, { timeout: 0 });
  try {
    const busy = (() => {
      try {
        return (db.prepare('SELECT count(*) AS n FROM targets WHERE lease_until > ?').get(now.toISOString()) as { n: number }).n;
      } catch {
        return 0; // a database from before leases existed
      }
    })();
    if (busy > 0) throw new RestoreError(msg('다른 fanout 프로세스가 작업 중입니다 (대상 {busy}개). 대시보드·worker·watch·mcp 를 모두 끈 뒤 다시 하세요 (--force 로 무시)', { busy }));
    try {
      db.exec('PRAGMA journal_mode = DELETE');
    } catch (err) {
      const code = (err as { errcode?: number }).errcode;
      // SQLITE_BUSY / SQLITE_LOCKED: someone else has it open. Anything else (a corrupt file) is its own problem.
      if (code === 5 || code === 6) {
        throw new RestoreError(msg('다른 fanout 프로세스(대시보드·worker·watch·mcp)가 데이터베이스를 열고 있습니다. 모두 끈 뒤 다시 하세요 (--force 로 무시)'));
      }
      throw new RestoreError(msg('지금 데이터베이스를 확인할 수 없습니다: {err}. 손상된 파일이라면 --force 로 복원하세요 (이전 파일은 따로 보관됩니다)', { err: (err as Error).message }));
    }
  } finally {
    db.close();
  }
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
  if (!existsSync(backupDb)) throw new RestoreError(msg('{backupDir} 에 fanout.db 가 없습니다. fanout backup 으로 만든 fanout-<시각> 폴더를 지정하세요', { backupDir }));

  // 1. The backup must be an intact fanout database.
  let posts = 0;
  let accounts = 0;
  let sealed: string[] = [];
  const db = readOnly(backupDb);
  // Copy through SQLite, not the file system: a copy of a live folder may hold data in fanout.db-wal.
  const staged = join(home, `.restore-${process.pid}-${Date.now()}.db`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  try {
    const ok = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
    if (ok !== 'ok') throw new RestoreError(msg('백업 DB가 손상됐습니다: {ok}', { ok }));
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name));
    for (const t of ['posts', 'targets', 'accounts', 'apps']) if (!tables.has(t)) throw new RestoreError(msg('fanout 백업이 아닙니다 ({t} 테이블 없음)', { t }));
    posts = (db.prepare('SELECT count(*) AS n FROM posts').get() as { n: number }).n;
    accounts = (db.prepare('SELECT count(*) AS n FROM accounts').get() as { n: number }).n;
    // Account tokens and app credentials are both sealed with the key.
    sealed = [
      (db.prepare('SELECT credentials AS v FROM accounts LIMIT 1').get() as { v: string } | undefined)?.v,
      (db.prepare("SELECT config AS v FROM apps WHERE config LIKE 'v1.%' LIMIT 1").get() as { v: string } | undefined)?.v,
    ].filter((v): v is string => Boolean(v));
    rmSync(staged, { force: true });
    db.prepare('VACUUM INTO ?').run(staged);
  } catch (err) {
    rmSync(staged, { force: true });
    throw err;
  } finally {
    db.close();
  }

  // 2. Its tokens must open with the key that will be used afterwards.
  const backupKey = join(backupDir, 'secret.key');
  const homeKey = join(home, 'secret.key');
  const keyText = opts.envKey ?? (existsSync(backupKey) ? readFileSync(backupKey, 'utf8') : existsSync(homeKey) ? readFileSync(homeKey, 'utf8') : undefined);
  try {
    if (sealed.length) {
      if (!keyText) throw new RestoreError(msg('백업에 secret.key 가 없고 FANOUT_SECRET_KEY 도 없어 저장된 토큰을 풀 수 없습니다'));
      const box = new SecretBox(Buffer.from(keyText.trim(), 'base64'));
      for (const s of sealed) {
        try {
          box.open(s);
        } catch {
          throw new RestoreError(
            opts.envKey ? msg('FANOUT_SECRET_KEY 로 백업의 토큰을 풀 수 없습니다. 백업할 때의 키를 지정하세요') : msg('백업의 토큰을 풀 수 있는 키가 없습니다 (백업의 secret.key 를 확인하세요)'),
          );
        }
      }
    }
    assertNotInUse(join(home, 'fanout.db'), now, opts.force);
  } catch (err) {
    rmSync(staged, { force: true });
    throw err;
  }

  // 3. Move the current data aside, then put the backup in place.
  const currentDb = join(home, 'fanout.db');
  let savedTo: string | undefined;
  const present = [...DB_FILES, ...(existsSync(backupKey) && !opts.envKey ? ['secret.key'] : [])].filter((f) => existsSync(join(home, f)));
  if (present.length) {
    savedTo = join(home, `before-restore-${now.toISOString().replace(/[:.]/g, '-')}`);
    mkdirSync(savedTo, { recursive: true, mode: 0o700 });
    for (const f of present) renameSync(join(home, f), join(savedTo, f));
  }
  renameSync(staged, currentDb);
  chmodSync(currentDb, 0o600);
  const keyRestored = existsSync(backupKey) && !opts.envKey;
  if (keyRestored) {
    copyFileSync(backupKey, homeKey);
    chmodSync(homeKey, 0o600);
  }
  return { posts, accounts, savedTo, keyRestored };
}
