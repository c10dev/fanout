import type { MediaInfo, MediaSpec } from './media.ts';
import type { Account, Store } from './store.ts';
import type { Capabilities, Issue, Post, Target } from './types.ts';

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

  /** Ensure credentials are fresh; persist and return the refreshed account if they changed. */
  refresh(ctx: ProviderContext, account: Account): Promise<Account>;

  /** Validate per-platform options and post fields before any upload. Media spec is checked separately. */
  validate(post: Post, target: Target, media: MediaInfo): Issue[];

  /** Adjust the generic spec for this specific post, e.g. TikTok's per-creator max duration. */
  specFor?(post: Post, target: Target): MediaSpec;

  publish(args: PublishArgs): Promise<PublishOutcome>;
  poll(args: PollArgs): Promise<PollOutcome>;
  doctor(args: DoctorArgs): Promise<DoctorCheck[]>;
}
