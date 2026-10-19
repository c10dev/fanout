import { randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { SecretBox } from './crypto.ts';
import { assertTransition } from './state.ts';
import type { Post, PostInput, PostStats, StatsPoint, Target, TargetEvent, TargetInput, TargetState } from './types.ts';

/** Account names: short ASCII, so they are never mistaken for text (or translated) anywhere. */
export const ACCOUNT_NAME = /^[A-Za-z0-9_-]{1,32}$/;

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
CREATE INDEX IF NOT EXISTS targets_by_post ON targets(post_id);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id TEXT NOT NULL,
  at TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS events_by_target ON events(target_id);
CREATE TABLE IF NOT EXISTS stats_history (
  target_id TEXT NOT NULL,
  at TEXT NOT NULL,
  views INTEGER,
  likes INTEGER,
  comments INTEGER,
  shares INTEGER,
  PRIMARY KEY (target_id, at)
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
    // Post records and upload session URLs aren't encrypted: keep the file (and the WAL and SHM
    // files SQLite creates with the same mode) to the owner, even in a home that already existed.
    if (path !== ':memory:') {
      try {
        chmodSync(path, 0o600);
      } catch {
        // Not ours to change (e.g. a read-only mount); the home directory is still 0700.
      }
    }
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

  /**
   * Save `account` only if the stored one still passes `same` (e.g. holds the refresh token just
   * used): a token refresh that finishes after the account was removed or reconnected elsewhere
   * must not bring the old one back. Returns whether it saved.
   */
  saveAccountIf(account: Account<unknown>, same: (stored: Account) => boolean): boolean {
    return this.transaction(() => {
      const stored = this.getAccount(account.platform, account.name);
      if (!stored || !same(stored)) return false;
      this.saveAccount(account);
      return true;
    });
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

  /**
   * Forget the reactions read from the platform for one account's targets (latest and history).
   * Posts, targets and their links stay: they are the user's own record of what they posted.
   * Returns how many targets had stats.
   */
  purgeAccountStats(platform: string, account: string): number {
    return this.transaction(() => {
      this.#db
        .prepare('DELETE FROM stats_history WHERE target_id IN (SELECT id FROM targets WHERE platform = ? AND account = ?)')
        .run(platform, account);
      return Number(this.#db.prepare('UPDATE targets SET stats = NULL WHERE platform = ? AND account = ? AND stats IS NOT NULL').run(platform, account).changes);
    });
  }

  // ── Posts and targets ────────────────────────────────────────────

  createPost(input: PostInput, targets: TargetInput[], notBefore?: string): { post: Post; targets: Target[] } {
    const now = this.#now().toISOString();
    const post: Post = { ...input, id: randomUUID(), createdAt: now };
    const insertPost = this.#db.prepare('INSERT INTO posts (id, body, created_at) VALUES (?, ?, ?)');
    return this.transaction(() => {
      insertPost.run(post.id, JSON.stringify(post), now);
      return { post, targets: this.#insertTargets(post.id, targets, () => notBefore, now) };
    });
  }

  #txDepth = 0;

  /**
   * Run `fn` in one write transaction (BEGIN IMMEDIATE, so other processes wait instead of
   * interleaving). Nested calls join the outer transaction.
   */
  transaction<T>(fn: () => T): T {
    if (this.#txDepth > 0) return fn();
    this.#db.exec('BEGIN IMMEDIATE');
    this.#txDepth++;
    try {
      const out = fn();
      this.#db.exec('COMMIT');
      return out;
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    } finally {
      this.#txDepth--;
    }
  }

  /** Queue more targets on an existing post (e.g. a platform added later), all or none. */
  addTargets(postId: string, targets: TargetInput[], notBefore: (t: TargetInput) => string | undefined = () => undefined): Target[] {
    return this.transaction(() => this.#insertTargets(postId, targets, notBefore, this.#now().toISOString()));
  }

  #insertTargets(postId: string, targets: TargetInput[], notBefore: (t: TargetInput) => string | undefined, now: string): Target[] {
    const insertTarget = this.#db.prepare(
      `INSERT INTO targets (id, post_id, platform, account, options, state, not_before, updated_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
    );
    const insertEvent = this.#db.prepare('INSERT INTO events (target_id, at, from_state, to_state) VALUES (?, ?, NULL, ?)');
    return targets.map((t) => {
      const id = randomUUID();
      insertTarget.run(id, postId, t.platform, t.account, JSON.stringify(t.options), notBefore(t) ?? null, now);
      insertEvent.run(id, now, 'queued');
      return this.getTarget(id)!;
    });
  }

  /** Posts of the same video (by content hash), newest first. */
  postsWithHash(hash: string): Post[] {
    const rows = this.#db
      .prepare("SELECT body FROM posts WHERE json_extract(body, '$.mediaHash') = ? ORDER BY created_at DESC")
      .all(hash) as Array<{ body: string }>;
    return rows.map((r) => JSON.parse(r.body) as Post);
  }

  updatePost(id: string, patch: Partial<Pick<Post, 'title' | 'description' | 'tags' | 'thumbnailPath' | 'captions'>>): Post {
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

  /** Newest posts first; `query` matches the title, the description or the start of the id. */
  listPosts(limit = 20, query?: string): Post[] {
    const q = query?.trim();
    if (!q) {
      const rows = this.#db.prepare('SELECT body FROM posts ORDER BY created_at DESC LIMIT ?').all(limit) as Array<{ body: string }>;
      return rows.map((r) => JSON.parse(r.body) as Post);
    }
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = this.#db
      .prepare(
        `SELECT body FROM posts
         WHERE json_extract(body, '$.title') LIKE ? ESCAPE '\\' OR json_extract(body, '$.description') LIKE ? ESCAPE '\\' OR id LIKE ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      // Only something that looks like an id prefix is matched against ids.
      .all(like, like, /^[0-9a-f-]{4,}$/i.test(q) ? `${q.toLowerCase()}%` : '\u0000', limit) as Array<{ body: string }>;
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
         WHERE (state IN ('queued', 'processing') AND (not_before IS NULL OR not_before <= ?))
            OR state IN ('transcoding', 'uploading')
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

  /**
   * Scheduled posts still to go out, soonest first: scheduled from `fromIso` on, or past their time
   * but with a target still waiting (the worker was off). Posts given up on everywhere are left out.
   */
  listScheduled(fromIso: string, limit = 50): Post[] {
    const rows = this.#db
      .prepare(
        `SELECT body FROM posts p
         WHERE json_extract(p.body, '$.scheduledAt') IS NOT NULL
           AND EXISTS (SELECT 1 FROM targets t WHERE t.post_id = p.id AND t.state NOT IN ('canceled', 'failed', 'removed'))
           AND (json_extract(p.body, '$.scheduledAt') >= ?
                OR EXISTS (SELECT 1 FROM targets t WHERE t.post_id = p.id AND t.state IN ('queued', 'transcoding', 'uploading', 'processing')))
         ORDER BY json_extract(p.body, '$.scheduledAt') LIMIT ?`,
      )
      .all(fromIso, limit) as Array<{ body: string }>;
    return rows.map((r) => JSON.parse(r.body) as Post);
  }

  /** Times at or after `fromIso` that posts are scheduled for, unless every target of the post was given up on. */
  scheduledTimes(fromIso: string): string[] {
    const rows = this.#db
      .prepare(
        `SELECT DISTINCT json_extract(p.body, '$.scheduledAt') AS at FROM posts p
         WHERE json_extract(p.body, '$.scheduledAt') >= ?
           AND EXISTS (SELECT 1 FROM targets t WHERE t.post_id = p.id AND t.state NOT IN ('canceled', 'failed', 'removed'))`,
      )
      .all(fromIso) as Array<{ at: string }>;
    return rows.map((r) => r.at);
  }

  /** Whether a target of the same account, other than `exceptId`, already points at this remote object. */
  remoteIdInUse(platform: string, account: string, remoteId: string, exceptId: string): boolean {
    // Remote ids are only unique per account's instance (PeerTube numbers videos per instance).
    return Boolean(
      this.#db.prepare('SELECT 1 FROM targets WHERE platform = ? AND account = ? AND remote_id = ? AND id != ? LIMIT 1').get(platform, account, remoteId, exceptId),
    );
  }

  /** Every published target (optionally of one platform), e.g. for insights. */
  publishedTargets(platform?: string): Target[] {
    const rows = (platform
      ? this.#db.prepare("SELECT * FROM targets WHERE state = 'published' AND platform = ?").all(platform)
      : this.#db.prepare("SELECT * FROM targets WHERE state = 'published'").all()) as unknown as TargetRow[];
    return rows.map(toTarget);
  }

  /** An account's targets in one state (e.g. its other hand-offs still waiting in the app). */
  targetsInState(platform: string, account: string, state: TargetState): Target[] {
    const rows = this.#db.prepare('SELECT * FROM targets WHERE platform = ? AND account = ? AND state = ?').all(platform, account, state) as unknown as TargetRow[];
    return rows.map(toTarget);
  }

  /** Keep a dated copy of a successful stats read, for trends. */
  recordStats(id: string, stats: PostStats): void {
    this.#db
      .prepare('INSERT OR IGNORE INTO stats_history (target_id, at, views, likes, comments, shares) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, stats.fetchedAt, stats.views ?? null, stats.likes ?? null, stats.comments ?? null, stats.shares ?? null);
  }

  /** Stats readings of a target, oldest first. */
  statsHistory(id: string, sinceIso?: string): StatsPoint[] {
    const rows = this.#db
      .prepare('SELECT at, views, likes, comments, shares FROM stats_history WHERE target_id = ? AND at >= ? ORDER BY at')
      .all(id, sinceIso ?? '') as Array<{ at: string; views: number | null; likes: number | null; comments: number | null; shares: number | null }>;
    return rows.map((r) => ({ at: r.at, views: r.views ?? undefined, likes: r.likes ?? undefined, comments: r.comments ?? undefined, shares: r.shares ?? undefined }));
  }

  /**
   * Published targets of posts created since `postedSince` whose stats are older than `staleBefore`
   * (or were never read), oldest reading first.
   */
  statsDue(postedSince: string, staleBefore: string, platforms: readonly string[], limit = 50, state: 'published' | 'handed_off' = 'published'): Array<{ id: string; postId: string; platform: string }> {
    // Filter platforms here, not after the LIMIT: targets that are never read would otherwise sit
    // at the front of the queue forever and starve everything behind them.
    if (!platforms.length) return [];
    return this.#db
      .prepare(
        `SELECT t.id, t.post_id AS postId, t.platform FROM targets t JOIN posts p ON p.id = t.post_id
         WHERE t.state = ? AND t.remote_id IS NOT NULL AND (p.created_at >= ? OR t.updated_at >= ?)
           AND t.platform IN (${platforms.map(() => '?').join(', ')})
           AND (t.stats IS NULL OR json_extract(t.stats, '$.fetchedAt') < ?)
         ORDER BY json_extract(t.stats, '$.fetchedAt') LIMIT ?`,
      )
      .all(state, postedSince, postedSince, ...platforms, staleBefore, limit) as Array<{ id: string; postId: string; platform: string }>;
  }

  /** The latest stats reading at or before `atOrBefore`. */
  statsBaseline(id: string, atOrBefore: string): StatsPoint | undefined {
    const r = this.#db
      .prepare('SELECT at, views, likes, comments, shares FROM stats_history WHERE target_id = ? AND at <= ? ORDER BY at DESC LIMIT 1')
      .get(id, atOrBefore) as { at: string; views: number | null; likes: number | null; comments: number | null; shares: number | null } | undefined;
    return r ? { at: r.at, views: r.views ?? undefined, likes: r.likes ?? undefined, comments: r.comments ?? undefined, shares: r.shares ?? undefined } : undefined;
  }

  /** The newest stats reading. */
  latestStats(id: string): StatsPoint | undefined {
    return this.statsBaseline(id, '9999');
  }

  bumpUsage(platform: string, account: string, day: string, by = 1): number {
    this.#db
      .prepare(
        `INSERT INTO usage (platform, account, day, count) VALUES (?, ?, ?, ?)
         ON CONFLICT(platform, account, day) DO UPDATE SET count = count + excluded.count`,
      )
      .run(platform, account, day, by);
    return this.getUsage(platform, account, day);
  }

  getUsage(platform: string, account: string, day: string): number {
    const row = this.#db.prepare('SELECT count FROM usage WHERE platform = ? AND account = ? AND day = ?').get(platform, account, day) as
      | { count: number }
      | undefined;
    return row?.count ?? 0;
  }
}
