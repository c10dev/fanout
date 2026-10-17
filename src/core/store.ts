import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { SecretBox } from './crypto.ts';
import { assertTransition } from './state.ts';
import type { Post, PostInput, PostStats, Target, TargetEvent, TargetInput, TargetState } from './types.ts';

export interface Account<C = Record<string, unknown>> {
  platform: string;
  name: string;
  credentials: C;
  /** Non-secret display data: channel title, page name, TikTok nickname… */
  profile: Record<string, unknown>;
}

type TargetPatch = Partial<
  Pick<Target, 'remoteId' | 'remoteUrl' | 'resume' | 'warnings' | 'errorCode' | 'errorMessage' | 'attempts' | 'notBefore' | 'options'>
>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS apps (
  platform TEXT PRIMARY KEY,
  config TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  platform TEXT NOT NULL,
  name TEXT NOT NULL,
  credentials TEXT NOT NULL,
  profile TEXT NOT NULL,
  PRIMARY KEY (platform, name)
);
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS targets (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id),
  platform TEXT NOT NULL,
  account TEXT NOT NULL,
  options TEXT NOT NULL,
  state TEXT NOT NULL,
  remote_id TEXT,
  remote_url TEXT,
  resume TEXT,
  warnings TEXT NOT NULL DEFAULT '[]',
  error_code TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS targets_by_state ON targets(state);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id TEXT NOT NULL,
  at TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS usage (
  platform TEXT NOT NULL,
  account TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (platform, account, day)
);
`;

interface TargetRow {
  id: string;
  post_id: string;
  platform: string;
  account: string;
  options: string;
  state: string;
  remote_id: string | null;
  remote_url: string | null;
  resume: string | null;
  warnings: string;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  not_before: string | null;
  updated_at: string;
  stats: string | null;
}

function toTarget(row: TargetRow): Target {
  return {
    id: row.id,
    postId: row.post_id,
    platform: row.platform,
    account: row.account,
    options: JSON.parse(row.options),
    state: row.state as TargetState,
    remoteId: row.remote_id ?? undefined,
    remoteUrl: row.remote_url ?? undefined,
    resume: row.resume ? JSON.parse(row.resume) : undefined,
    warnings: JSON.parse(row.warnings),
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    attempts: row.attempts,
    notBefore: row.not_before ?? undefined,
    updatedAt: row.updated_at,
    stats: row.stats ? JSON.parse(row.stats) : undefined,
  };
}

/** SQLite-backed state: BYO apps, connected accounts, posts, per-platform targets and their event log. */
export class Store {
  readonly #db: DatabaseSync;
  readonly #box: SecretBox;
  readonly #now: () => Date;
  readonly #listeners: Array<(target: Target, from: TargetState) => void> = [];

  constructor(path: string, box: SecretBox, now: () => Date = () => new Date()) {
    // Other fanout processes (dashboard, CLI, watch, MCP) write to the same file: wait for their
    // write transactions instead of failing right after a platform side effect.
    this.#db = new DatabaseSync(path, { timeout: 10_000 });
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.#db.exec(SCHEMA);
    this.#migrate();
    this.#box = box;
    this.#now = now;
  }

  /** Consistent snapshot of the whole database, safe while other processes keep writing. */
  backupTo(path: string): void {
    this.#db.prepare('VACUUM INTO ?').run(path);
  }

  close(): void {
    this.#db.close();
  }

  /** Add columns introduced after a database was created. */
  #migrate(): void {
    const cols = new Set((this.#db.prepare('PRAGMA table_info(targets)').all() as Array<{ name: string }>).map((c) => c.name));
    if (!cols.has('lease_owner')) this.#db.exec('ALTER TABLE targets ADD COLUMN lease_owner TEXT');
    if (!cols.has('lease_until')) this.#db.exec('ALTER TABLE targets ADD COLUMN lease_until TEXT');
    if (!cols.has('stats')) this.#db.exec('ALTER TABLE targets ADD COLUMN stats TEXT');
  }

  // ── Leases: one process works on a target at a time ──────────────

  /**
   * Atomically take the target for `owner` until now + ttl. Succeeds when the target is free, the
   * lease expired, `owner` already holds it, or `isStale(currentOwner)` says the holder is gone.
   */
  claim(id: string, owner: string, ttlMs: number, isStale: (holder: string) => boolean = () => false): boolean {
    const now = this.#now();
    const until = new Date(now.getTime() + ttlMs).toISOString();
    const take = this.#db.prepare(
      `UPDATE targets SET lease_owner = ?, lease_until = ?
       WHERE id = ? AND (lease_owner IS NULL OR lease_until IS NULL OR lease_until < ? OR lease_owner = ?)`,
    );
    if (take.run(owner, until, id, now.toISOString(), owner).changes > 0) return true;
    const holder = this.leaseHolder(id);
    if (!holder || !isStale(holder)) return false;
    // Steal only if the stale holder still has it (another process may have stolen it first).
    return (
      this.#db.prepare('UPDATE targets SET lease_owner = ?, lease_until = ? WHERE id = ? AND lease_owner = ?').run(owner, until, id, holder).changes > 0
    );
  }

  release(id: string, owner: string): void {
    this.#db.prepare('UPDATE targets SET lease_owner = NULL, lease_until = NULL WHERE id = ? AND lease_owner = ?').run(id, owner);
  }

  /** Current unexpired lease holder, if any. */
  leaseHolder(id: string): string | undefined {
    const row = this.#db.prepare('SELECT lease_owner, lease_until FROM targets WHERE id = ?').get(id) as
      | { lease_owner: string | null; lease_until: string | null }
      | undefined;
    if (!row?.lease_owner || !row.lease_until || row.lease_until < this.#now().toISOString()) return undefined;
    return row.lease_owner;
  }

  // ── BYO platform apps ────────────────────────────────────────────

  setApp(platform: string, config: Record<string, unknown>): void {
    this.#db
      .prepare('INSERT INTO apps (platform, config) VALUES (?, ?) ON CONFLICT(platform) DO UPDATE SET config = excluded.config')
      .run(platform, this.#box.seal(JSON.stringify(config)));
  }

  getApp<T = Record<string, unknown>>(platform: string): T | undefined {
    const row = this.#db.prepare('SELECT config FROM apps WHERE platform = ?').get(platform) as { config: string } | undefined;
    return row ? (JSON.parse(this.#box.open(row.config)) as T) : undefined;
  }

  // ── Accounts ─────────────────────────────────────────────────────

  saveAccount(account: Account<unknown>): void {
    this.#db
      .prepare(
        `INSERT INTO accounts (platform, name, credentials, profile) VALUES (?, ?, ?, ?)
         ON CONFLICT(platform, name) DO UPDATE SET credentials = excluded.credentials, profile = excluded.profile`,
      )
      .run(account.platform, account.name, this.#box.seal(JSON.stringify(account.credentials)), JSON.stringify(account.profile));
  }

  getAccount<C = Record<string, unknown>>(platform: string, name: string): Account<C> | undefined {
    const row = this.#db.prepare('SELECT * FROM accounts WHERE platform = ? AND name = ?').get(platform, name) as
      | { platform: string; name: string; credentials: string; profile: string }
      | undefined;
    if (!row) return undefined;
    return {
      platform: row.platform,
      name: row.name,
      credentials: JSON.parse(this.#box.open(row.credentials)) as C,
      profile: JSON.parse(row.profile),
    };
  }

  listAccounts(): Array<Omit<Account, 'credentials'>> {
    const rows = this.#db.prepare('SELECT platform, name, profile FROM accounts ORDER BY platform, name').all() as Array<{
      platform: string;
      name: string;
      profile: string;
    }>;
    return rows.map((r) => ({ platform: r.platform, name: r.name, profile: JSON.parse(r.profile) }));
  }

  removeAccount(platform: string, name: string): boolean {
    return this.#db.prepare('DELETE FROM accounts WHERE platform = ? AND name = ?').run(platform, name).changes > 0;
  }

  // ── Posts and targets ────────────────────────────────────────────

  createPost(input: PostInput, targets: TargetInput[], notBefore?: string): { post: Post; targets: Target[] } {
    const now = this.#now().toISOString();
    const post: Post = { ...input, id: randomUUID(), createdAt: now };
    const insertPost = this.#db.prepare('INSERT INTO posts (id, body, created_at) VALUES (?, ?, ?)');
    const insertTarget = this.#db.prepare(
      `INSERT INTO targets (id, post_id, platform, account, options, state, not_before, updated_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
    );
    const insertEvent = this.#db.prepare('INSERT INTO events (target_id, at, from_state, to_state) VALUES (?, ?, NULL, ?)');
    const created: Target[] = [];
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      insertPost.run(post.id, JSON.stringify(post), now);
      for (const t of targets) {
        const id = randomUUID();
        insertTarget.run(id, post.id, t.platform, t.account, JSON.stringify(t.options), notBefore ?? null, now);
        insertEvent.run(id, now, 'queued');
        created.push(this.getTarget(id)!);
      }
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    return { post, targets: created };
  }

  /** Posts of the same video (by content hash), newest first. */
  postsWithHash(hash: string): Post[] {
    const rows = this.#db
      .prepare("SELECT body FROM posts WHERE json_extract(body, '$.mediaHash') = ? ORDER BY created_at DESC")
      .all(hash) as Array<{ body: string }>;
    return rows.map((r) => JSON.parse(r.body) as Post);
  }

  updatePost(id: string, patch: Partial<Pick<Post, 'title' | 'description' | 'tags'>>): Post {
    const current = this.getPost(id);
    if (!current) throw new Error(`no post ${id}`);
    const next = { ...current, ...patch };
    this.#db.prepare('UPDATE posts SET body = ? WHERE id = ?').run(JSON.stringify(next), id);
    return next;
  }

  getPost(id: string): Post | undefined {
    const row = this.#db.prepare('SELECT body FROM posts WHERE id = ?').get(id) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as Post) : undefined;
  }

  /** Accepts a full id or a unique prefix, so the CLI can show short ids. */
  findPost(idOrPrefix: string): Post | undefined {
    const rows = this.#db.prepare('SELECT body FROM posts WHERE id LIKE ? LIMIT 2').all(`${idOrPrefix}%`) as Array<{ body: string }>;
    return rows.length === 1 ? (JSON.parse(rows[0]!.body) as Post) : undefined;
  }

  listPosts(limit = 20): Post[] {
    const rows = this.#db.prepare('SELECT body FROM posts ORDER BY created_at DESC LIMIT ?').all(limit) as Array<{ body: string }>;
    return rows.map((r) => JSON.parse(r.body) as Post);
  }

  getTarget(id: string): Target | undefined {
    const row = this.#db.prepare('SELECT * FROM targets WHERE id = ?').get(id) as TargetRow | undefined;
    return row ? toTarget(row) : undefined;
  }

  targetsForPost(postId: string): Target[] {
    const rows = this.#db.prepare('SELECT * FROM targets WHERE post_id = ? ORDER BY platform, account').all(postId) as unknown as TargetRow[];
    return rows.map(toTarget);
  }

  /** Targets a worker should act on now: queued and due, or still processing on the platform. */
  workableTargets(): Target[] {
    const now = this.#now().toISOString();
    const rows = this.#db
      .prepare(
        `SELECT * FROM targets
         WHERE (state = 'queued' AND (not_before IS NULL OR not_before <= ?))
            OR state IN ('transcoding', 'uploading', 'processing')
         ORDER BY updated_at`,
      )
      .all(now) as unknown as TargetRow[];
    return rows.map(toTarget);
  }

  updateTarget(id: string, patch: TargetPatch): Target {
    const current = this.getTarget(id);
    if (!current) throw new Error(`no target ${id}`);
    const next = { ...current, ...patch };
    this.#db
      .prepare(
        `UPDATE targets SET options = ?, remote_id = ?, remote_url = ?, resume = ?, warnings = ?, error_code = ?,
           error_message = ?, attempts = ?, not_before = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        JSON.stringify(next.options),
        next.remoteId ?? null,
        next.remoteUrl ?? null,
        next.resume ? JSON.stringify(next.resume) : null,
        JSON.stringify(next.warnings),
        next.errorCode ?? null,
        next.errorMessage ?? null,
        next.attempts,
        next.notBefore ?? null,
        this.#now().toISOString(),
        id,
      );
    return this.getTarget(id)!;
  }

  transition(id: string, to: TargetState, patch: TargetPatch = {}, detail?: string): Target {
    const current = this.getTarget(id);
    if (!current) throw new Error(`no target ${id}`);
    assertTransition(current.state, to);
    const now = this.#now().toISOString();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare('UPDATE targets SET state = ?, updated_at = ? WHERE id = ?').run(to, now, id);
      this.#db
        .prepare('INSERT INTO events (target_id, at, from_state, to_state, detail) VALUES (?, ?, ?, ?, ?)')
        .run(id, now, current.state, to, detail ?? null);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    const next = Object.keys(patch).length ? this.updateTarget(id, patch) : this.getTarget(id)!;
    for (const listener of this.#listeners) {
      try {
        listener(next, current.state);
      } catch {
        // A listener (e.g. notifications) must never break a state change.
      }
    }
    return next;
  }

  /** Called after every state change with the updated target and the state it came from. */
  onTransition(listener: (target: Target, from: TargetState) => void): void {
    this.#listeners.push(listener);
  }

  /** When the target last entered `state`, from its event log. */
  stateSince(targetId: string, state: TargetState): Date | undefined {
    const row = this.#db.prepare('SELECT at FROM events WHERE target_id = ? AND to_state = ? ORDER BY id DESC LIMIT 1').get(targetId, state) as
      | { at: string }
      | undefined;
    return row ? new Date(row.at) : undefined;
  }

  events(targetId: string): TargetEvent[] {
    const rows = this.#db.prepare('SELECT * FROM events WHERE target_id = ? ORDER BY id').all(targetId) as Array<{
      target_id: string;
      at: string;
      from_state: string | null;
      to_state: string;
      detail: string | null;
    }>;
    return rows.map((r) => ({
      targetId: r.target_id,
      at: r.at,
      from: r.from_state as TargetState | null,
      to: r.to_state as TargetState,
      detail: r.detail ?? undefined,
    }));
  }

  // ── Local usage counters (mirrors of platform quotas) ────────────

  /** Stats are observations, not state: saving them doesn't touch updated_at or the event log. */
  saveStats(id: string, stats: PostStats): void {
    this.#db.prepare('UPDATE targets SET stats = ? WHERE id = ?').run(JSON.stringify(stats), id);
  }

  bumpUsage(platform: string, account: string, day: string): number {
    this.#db
      .prepare(
        `INSERT INTO usage (platform, account, day, count) VALUES (?, ?, ?, 1)
         ON CONFLICT(platform, account, day) DO UPDATE SET count = count + 1`,
      )
      .run(platform, account, day);
    return this.getUsage(platform, account, day);
  }

  getUsage(platform: string, account: string, day: string): number {
    const row = this.#db.prepare('SELECT count FROM usage WHERE platform = ? AND account = ? AND day = ?').get(platform, account, day) as
      | { count: number }
      | undefined;
    return row?.count ?? 0;
  }
}
