export type ErrorKind =
  /** Worth trying again after a backoff (network, 5xx, platform rate limit). */
  | 'retryable'
  /** Token revoked or expired beyond refresh: the user must reconnect the account. */
  | 'auth'
  /** The post itself was refused (spec, policy, quota for today). Retrying unchanged will not help. */
  | 'rejected';

export class ProviderError extends Error {
  readonly kind: ErrorKind;
  /** Stable fanout code, e.g. `youtube.quota_exceeded`. */
  readonly code: string;
  /** The platform's own error code, kept verbatim for the status board. */
  readonly platformCode?: string;
  /**
   * Keep the target's remote state (upload ids, markers) when this fails it. By default a terminal
   * failure during processing clears it so a retry starts over; set this when the remote object may
   * still be live and starting over could post twice.
   */
  readonly keepResume: boolean;
  /**
   * A limit refused this for now and will take it again at this time (a daily cap's reset): the
   * runner queues the target for then instead of failing it.
   */
  readonly retryAt?: string;

  constructor(kind: ErrorKind, code: string, message: string, platformCode?: string, opts: { keepResume?: boolean; retryAt?: Date } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.code = code;
    this.platformCode = platformCode;
    this.keepResume = opts.keepResume ?? false;
    this.retryAt = opts.retryAt?.toISOString();
  }
}

/** Map an HTTP status to an error kind when the platform gives nothing more specific. */
export function kindForStatus(status: number): ErrorKind {
  if (status === 401) return 'auth';
  if (status === 408 || status === 429 || status >= 500) return 'retryable';
  return 'rejected';
}
