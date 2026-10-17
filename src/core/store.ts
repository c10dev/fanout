import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { SecretBox } from './crypto.ts';
import { assertTransition } from './state.ts';
import type { Post, PostInput, Target, TargetEvent, TargetInput, TargetState } from './types.ts';

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
  };
}

/** SQLite-backed state: BYO apps, connected accounts, posts, per-platform targets and their event log. */
export class Store {
  readonly #db: DatabaseSync;
  readonly #box: SecretBox;
  readonly #now: () => Date;

  constructor(path: string, box: SecretBox, now: () => Date = () => new Date()) {
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.#db.exec(SCHEMA);
    this.#box = box;
    this.#now = now;
  }

  close(): void {
    this.#db.close();
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
    this.#db.exec('BEGIN');
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
    this.#db.exec('BEGIN');
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
    return Object.keys(patch).length ? this.updateTarget(id, patch) : this.getTarget(id)!;
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
