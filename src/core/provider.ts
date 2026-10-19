import type { MediaInfo, MediaSpec } from './media.ts';
import type { Account, Store } from './store.ts';
import type { Capabilities, Comment, Issue, Post, PostStats, Target } from './types.ts';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface ProviderContext {
  store: Store;
  log: Logger;
  /** Overridable for tests. */
  fetch: typeof fetch;
  now: () => Date;
  home: string;
}

export interface PublishArgs {
  ctx: ProviderContext;
  post: Post;
  target: Target;
  account: Account;
  /** File to upload: the original, or a transcoded variant. */
  mediaPath: string;
  media: MediaInfo;
  /** Persist provider resume data (e.g. an upload session URI) as soon as it exists. */
  saveResume(resume: Record<string, unknown>): void;
}

export type PublishOutcome =
  /** Upload accepted; the platform is still working. Call `poll` later. */
  | { state: 'processing'; remoteId: string; remoteUrl?: string; warnings?: string[] }
  | { state: 'published'; remoteId: string; remoteUrl?: string; warnings?: string[] }
  /** Delivered to the user's drafts/inbox; they finish it in the platform app. */
  | { state: 'handed_off'; remoteId: string; remoteUrl?: string; warnings?: string[] };

export interface PollArgs {
  ctx: ProviderContext;
  post: Post;
  target: Target & { remoteId: string };
  account: Account;
}

export type PollOutcome = PublishOutcome;

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
}

export interface StatsArgs {
  ctx: ProviderContext;
  account: Account;
  target: Target & { remoteId: string };
}

export interface AccountRules {
  username?: string;
  nickname?: string;
  /** Visibility values this account may post with (platform values, e.g. TikTok privacy levels). */
  privacyOptions?: string[];
  /** Option names the account's own settings turn off (e.g. allowComment). */
  disabled?: string[];
  maxDurationSec?: number;
}

/** One posting limit of an account, as far as the platform (or fanout's own count) tells. */
export interface Limit {
  /** What is counted, as a message ("하루 업로드 (프로젝트 전체)"). */
  what: string;
  unit: 'posts' | 'bytes';
  used?: number;
  total?: number;
  remaining?: number;
  unlimited?: boolean;
  /** ISO time the count starts over, when it is a fixed time (not a rolling window). */
  resetsAt?: string;
  /** How the number is known when that matters ("로컬 집계"), or why it can't be used now. */
  note?: string;
}

export interface OAuthStart {
  url: string;
  state: string;
  verifier: string;
}

export interface DoctorArgs {
  ctx: ProviderContext;
  account: Account;
  /** Upload a throwaway test clip to answer questions only a real upload can answer. */
  live: boolean;
}

/**
 * One platform. Implementations must not ship app credentials: every user registers their own
 * developer app (BYO), stored via `fanout app set`.
 */
export interface Provider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: Capabilities;
  readonly spec: MediaSpec;

  /**
   * With native scheduling: how far ahead the platform accepts a schedule (Facebook: 29 days). A
   * post scheduled further out waits in fanout until it is within reach, then uploads.
   */
  readonly scheduleMaxAheadMs?: number;

  /** Store key for the BYO app when several providers share one developer app (Instagram + Facebook → "meta"). */
  readonly appKey?: string;
  /** Human setup guide for registering the user's own developer app. */
  setupGuide(): string;
  /** Fields `fanout app set <platform>` asks for. */
  readonly appFields: ReadonlyArray<{ key: string; label: string; secret: boolean; optional?: boolean }>;

  /**
   * How an account gets connected: `oauth` (browser redirect, see oauthBegin/oauthFinish) or
   * `token` (the user pastes a token; `connect` takes it as `flags.token`).
   */
  readonly connectMethod: 'oauth' | 'token';

  /** For connectMethod 'token': what the connect form asks for. Default: an access token and an optional page. */
  readonly connectFields?: ReadonlyArray<{ key: string; label: string; secret: boolean; optional?: boolean }>;

  /** Interactive account connection (CLI); returns the account to store. */
  connect(ctx: ProviderContext, name: string, flags: Record<string, string | boolean | undefined>): Promise<Account>;

  /** Build the authorization URL for a redirect to `redirectUri`. The caller keeps state + verifier. */
  oauthBegin?(ctx: ProviderContext, redirectUri: string): OAuthStart;
  /** Exchange the callback params (state already checked by the caller) for an account. */
  oauthFinish?(ctx: ProviderContext, name: string, params: URLSearchParams, redirectUri: string, verifier: string): Promise<Account>;

  /** Disconnecting through fanout: revoke the account's tokens at the platform. Resolves whether they are revoked now. */
  disconnect?(ctx: ProviderContext, account: Account): Promise<boolean>;

  /**
   * Prove the account is still authorized and return it with its stored profile re-read, for
   * platforms whose terms ask for both regularly (YouTube: every 30 days). Throws a ProviderError
   * of kind 'auth' when access is gone. See core/accounts.ts for the schedule.
   */
  verify?(ctx: ProviderContext, account: Account): Promise<Account>;
  /** Delete the data the platform's terms don't let fanout keep once access ends (YouTube: reactions). */
  forget?(ctx: ProviderContext, account: Account): void;

  /** Ensure credentials are fresh; persist and return the refreshed account if they changed. */
  refresh(ctx: ProviderContext, account: Account): Promise<Account>;

  /** Validate per-platform options and post fields before any upload. Media spec is checked separately. */
  /** `account` is the target's connected account when known (e.g. its subscription tier decides a limit). */
  validate(post: Post, target: Target, media: MediaInfo, account?: Account): Issue[];

  /** Adjust the generic spec for this specific post, e.g. TikTok's per-creator max duration. */
  specFor?(post: Post, target: Target): MediaSpec;

  publish(args: PublishArgs): Promise<PublishOutcome>;
  poll(args: PollArgs): Promise<PollOutcome>;
  doctor(args: DoctorArgs): Promise<DoctorCheck[]>;

  /**
   * The account's own posting rules as the platform reports them (TikTok creator_info): who it
   * posts as, which visibility values it allows, which interactions its settings turn off, how
   * long a video may be. The dashboard shapes its form from them.
   */
  accountRules?(args: { ctx: ProviderContext; account: Account }): Promise<AccountRules>;
  /** The account's playlists to pick from (YouTube), newest first as the platform lists them. */
  listPlaylists?(args: { ctx: ProviderContext; account: Account }): Promise<Array<{ id: string; title: string }>>;
  /** Checks of a planned post that need the account's live settings; run at preview, like limits. */
  previewChecks?(args: { ctx: ProviderContext; account: Account; post: Post; target: Target; media: MediaInfo }): Promise<Issue[]>;

  /** Posting limits of the account right now (daily uploads, storage). Omit when the platform has none to read. */
  limits?(args: { ctx: ProviderContext; account: Account }): Promise<Limit[]>;

  /** Views/likes/comments of a published post. Omit when the API (or granted scopes) can't read them. */
  stats?(args: StatsArgs): Promise<Omit<PostStats, 'fetchedAt'>>;
  /**
   * For a target handed off to the platform app (TikTok inbox): posts on the account that could be
   * the one the creator finished there since `since`. The core links one only when exactly one fits
   * and no other target already has it.
   */
  findHandedOff?(args: { ctx: ProviderContext; account: Account; target: Target; since: Date }): Promise<{ matches: Array<{ remoteId: string; remoteUrl?: string }>; note?: string }>;
  /** comments() says whether the account has answered each comment (the comment inbox reads only these). */
  readonly commentsKnowAnswers?: boolean;
  /** When the connection itself ends and the user must reconnect (a refresh token's end), if known. */
  signInExpiresAt?(account: Account): number | undefined;
  /** Set when reading stats is billed (X); stats are then fetched only on explicit request. */
  readonly statsCost?: string;

  /** Delete a published post from the platform. Omit when the API can't. Resolve if it's already gone. */
  remove?(args: StatsArgs): Promise<void>;

  /** Newest top-level comments on a published post. Omit when the API can't read them. */
  comments?(args: StatsArgs & { limit: number }): Promise<Comment[]>;

  /**
   * Reply, as the connected account, to one of the post's top-level comments (already checked to
   * be among `comments()`). Called once and never retried by fanout: platforms without an
   * idempotency key could otherwise end up with the reply twice. Call `sending()` right before the
   * request that creates the reply, so a failure before it isn't reported as "may have posted".
   */
  reply?(args: StatsArgs & { comment: Comment; text: string; sending: () => void }): Promise<{ id: string; url?: string }>;

  /**
   * Post `text` as a top-level comment on the account's own published post (the post's first
   * comment). Like reply: called once, `sending()` right before the request that creates it.
   */
  postComment?(args: StatsArgs & { text: string; sending: () => void }): Promise<{ id: string; url?: string }>;

  /** Apply an edited title/description/tags (already saved on `post`) to the published post. */
  update?(args: StatsArgs & { post: Post }): Promise<void>;

  /**
   * Hide (or show again) a comment on the account's own post: reversible on every platform that has
   * it (YouTube holds it for review, Instagram and Facebook hide it). Omit when the API can't.
   */
  hideComment?(args: StatsArgs & { commentId: string; hidden: boolean }): Promise<void>;

  /** Visibility values setVisibility accepts (YouTube: public, unlisted, private). */
  readonly visibilities?: readonly string[];
  /**
   * Change a published post's visibility, optionally to go public at `publishAt` (kept private until
   * then). Omit when the platform can't.
   */
  setVisibility?(args: StatsArgs & { visibility: string; publishAt?: string }): Promise<{ visibility: string; publishAt?: string }>;
}

/** The media rules for one target: the platform's, plus a vertical fit when the target asks for one. */
export function targetSpec(provider: Provider, post: Post, target: Target): MediaSpec {
  const base = provider.specFor?.(post, target) ?? provider.spec;
  const fit = (target.options as { fit?: unknown }).fit;
  return fit === 'pad' || fit === 'crop' ? { ...base, fit } : base;
}
