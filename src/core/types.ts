// Shared domain types. Platform-specific option shapes live next to each provider.

export type PlatformId = string;

/**
 * Lifecycle of one post on one platform.
 *
 *   queued → transcoding → uploading → processing → published
 *                                   ↘ handed_off   (finished by the user in the platform app, e.g. TikTok inbox)
 *   any non-terminal state → failed | needs_reauth
 *   published → removed   (the user deleted it from the platform through fanout)
 *   queued | failed | needs_reauth → canceled   (the user gave up on it before it went out)
 */
export type TargetState =
  | 'queued'
  | 'transcoding'
  | 'uploading'
  | 'processing'
  | 'published'
  | 'handed_off'
  | 'failed'
  | 'needs_reauth'
  | 'removed'
  | 'canceled';

export interface CaptionFile {
  language: string;
  path: string;
  name?: string;
}

/** What the creator wants to post. Platform-neutral. */
export interface PostInput {
  mediaPath: string;
  title: string;
  description: string;
  tags: string[];
  thumbnailPath?: string;
  captions: CaptionFile[];
  /** Disclose realistic AI-generated or altered content where the platform supports it. */
  containsSyntheticMedia: boolean;
  /** ISO-8601. When set, providers with native scheduling hand it to the platform. */
  scheduledAt?: string;
  /** SHA-256 of the original video, to notice the same video being posted again. */
  mediaHash?: string;
}

export interface TargetInput {
  platform: PlatformId;
  account: string;
  options: Record<string, unknown>;
}

export interface Post extends PostInput {
  id: string;
  createdAt: string;
}

/** A top-level comment on a published post, normalized across platforms. */
export interface Comment {
  id: string;
  /** Empty when the platform doesn't say; displays fill in their own placeholder. */
  author: string;
  text: string;
  at: string;
  likes?: number;
  replies?: number;
  url?: string;
  /** Hidden from the public (Meta's hide, YouTube's held for review). */
  hidden?: boolean;
}

/** Audience reaction to a published post, as far as the platform API and granted scopes allow. */
export interface PostStats {
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  /** Accounts that saw it at least once (Instagram, Facebook). */
  reach?: number;
  /** Times it was saved (Instagram). */
  saves?: number;
  /** Average watch time per view, in seconds (Instagram, Facebook, YouTube). */
  avgWatchSec?: number;
  /** Total time watched, in seconds (Instagram, Facebook, YouTube). */
  watchTimeSec?: number;
  /** Average share of the video watched per view, in percent (YouTube). */
  avgViewPct?: number;
  /** Subscriptions from the video's own page (YouTube). */
  subscribersGained?: number;
  fetchedAt: string;
  /** What couldn't be read, or why. */
  note?: string;
}

/** One dated stats reading (see Store.recordStats). */
export interface StatsPoint {
  at: string;
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
}

/** Change over a period: current reading minus the one at its start. */
export interface StatsTrend {
  /** Reading the change is measured from. */
  since: string;
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
}

export interface Target {
  id: string;
  postId: string;
  platform: PlatformId;
  account: string;
  options: Record<string, unknown>;
  state: TargetState;
  remoteId?: string;
  remoteUrl?: string;
  /** Provider-owned resume data, e.g. a YouTube resumable session URI. */
  resume?: Record<string, unknown>;
  warnings: string[];
  errorCode?: string;
  errorMessage?: string;
  attempts: number;
  notBefore?: string;
  updatedAt: string;
  stats?: PostStats;
}

export interface TargetEvent {
  targetId: string;
  at: string;
  from: TargetState | null;
  to: TargetState;
  detail?: string;
}

export interface Capabilities {
  nativeSchedule: boolean;
  thumbnail: boolean;
  captions: boolean;
  syntheticMediaFlag: boolean;
}

export interface Issue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
}
