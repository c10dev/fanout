import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { SecretBox } from '../src/core/crypto.ts';
import { restoreBackup } from '../src/core/restore.ts';
import { Store } from '../src/core/store.ts';

const NOW = new Date('2026-10-17T03:00:00Z');
const POST = { mediaPath: '/v.mp4', title: 'backed up', description: '', tags: [], captions: [], containsSyntheticMedia: false };

/** A data folder with a key, one account and one post, plus a backup of it. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'fanout-restore-'));
  const home = join(root, 'home');
  mkdirSync(home);
  const key = randomBytes(32);
  writeFileSync(join(home, 'secret.key'), key.toString('base64'), { mode: 0o600 });
  const store = new Store(join(home, 'fanout.db'), new SecretBox(key), () => NOW);
  store.saveAccount({ platform: 'youtube', name: 'main', credentials: { accessToken: 'secret' }, profile: {} });
  store.createPost(POST, [{ platform: 'youtube', account: 'main', options: {} }]);
  const backup = join(root, 'backup');
  mkdirSync(backup);
  store.backupTo(join(backup, 'fanout.db'));
  writeFileSync(join(backup, 'secret.key'), key.toString('base64'));
  return { root, home, key, store, backup };
}

describe('fanout restore', () => {
  it('puts the backup back and keeps the data it replaces', () => {
    const { home, key, store, backup } = setup();
    store.createPost({ ...POST, title: 'after the backup' }, []);
    store.close();
    const r = restoreBackup({ home, backupDir: backup, now: NOW });
    assert.deepEqual([r.posts, r.accounts, r.keyRestored], [1, 1, true]);
    assert.ok(r.savedTo && existsSync(join(r.savedTo, 'fanout.db')));
    const back = new Store(join(home, 'fanout.db'), new SecretBox(key), () => NOW);
    assert.deepEqual(back.listPosts(10).map((p) => p.title), ['backed up']);
    assert.equal(back.getAccount('youtube', 'main')!.credentials.accessToken, 'secret');
    assert.equal(statSync(join(home, 'fanout.db')).mode & 0o777, 0o600);
    back.close();
  });

  it('refuses something that is not a fanout backup', () => {
    const { home, root, store } = setup();
    store.close();
    const bogus = join(root, 'bogus');
    mkdirSync(bogus);
    writeFileSync(join(bogus, 'fanout.db'), 'not a database at all');
    assert.throws(() => restoreBackup({ home, backupDir: bogus, now: NOW }));
    assert.throws(() => restoreBackup({ home, backupDir: join(root, 'missing'), now: NOW }), /fanout\.db 가 없습니다/);
    assert.ok(existsSync(join(home, 'fanout.db')), 'current data untouched');
  });

  it('refuses a key that cannot open the backup tokens', () => {
    const { home, backup, store } = setup();
    store.close();
    assert.throws(() => restoreBackup({ home, backupDir: backup, now: NOW, envKey: randomBytes(32).toString('base64') }), /FANOUT_SECRET_KEY/);
    assert.equal(readdirSync(home).some((f) => f.startsWith('before-restore')), false, 'nothing moved');
  });

  it('refuses while another process holds a lease, unless forced', () => {
    const { home, backup, store } = setup();
    const t = store.targetsForPost(store.listPosts(1)[0]!.id)[0]!;
    assert.ok(store.claim(t.id, 'other-host:1:x', 60 * 60_000));
    store.close();
    assert.throws(() => restoreBackup({ home, backupDir: backup, now: NOW }), /작업 중/);
    assert.equal(restoreBackup({ home, backupDir: backup, now: NOW, force: true }).posts, 1);
    assert.ok(readFileSync(join(home, 'secret.key'), 'utf8'));
  });
});

describe('fanout restore, eleventh review fixes', () => {
  it('refuses while another process merely has the database open', async () => {
    const { spawn } = await import('node:child_process');
    const { home, backup, store } = setup();
    store.close();
    const child = spawn(process.execPath, ['-e', `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(${JSON.stringify(join(home, 'fanout.db'))}); db.prepare('SELECT 1').get(); console.log('open'); setInterval(() => {}, 1000);`]);
    await new Promise((r) => child.stdout.once('data', r));
    try {
      assert.throws(() => restoreBackup({ home, backupDir: backup, now: NOW }), /열고 있습니다/);
    } finally {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
    assert.equal(restoreBackup({ home, backupDir: backup, now: NOW }).posts, 1);
  });

  it('a copy of a live folder keeps what was still in the WAL', () => {
    const { root, home, key, store } = setup();
    store.createPost({ ...POST, title: 'in the wal' }, []);
    const copy = join(root, 'live-copy');
    mkdirSync(copy);
    for (const f of ['fanout.db', 'fanout.db-wal', 'fanout.db-shm', 'secret.key']) if (existsSync(join(home, f))) writeFileSync(join(copy, f), readFileSync(join(home, f)));
    store.close();
    const r = restoreBackup({ home, backupDir: copy, now: NOW });
    const back = new Store(join(home, 'fanout.db'), new SecretBox(key), () => NOW);
    assert.equal(back.listPosts(10).length, r.posts);
    assert.ok(back.listPosts(10).some((p) => p.title === 'in the wal'));
    back.close();
  });

  it('checks app credentials against the key too', () => {
    const { root, home, store } = setup();
    store.close();
    // A backup with app credentials only, made with another key and without it.
    const other = new Store(join(root, 'other.db'), new SecretBox(randomBytes(32)), () => NOW);
    other.setApp('youtube', { clientId: 'c', clientSecret: 's' });
    const bk = join(root, 'apps-only');
    mkdirSync(bk);
    other.backupTo(join(bk, 'fanout.db'));
    other.close();
    assert.throws(() => restoreBackup({ home, backupDir: bk, now: NOW }), /키/);
  });
});
