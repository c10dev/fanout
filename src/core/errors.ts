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

  constructor(kind: ErrorKind, code: string, message: string, platformCode?: string) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.code = code;
    this.platformCode = platformCode;
  }
}

/** Map an HTTP status to an error kind when the platform gives nothing more specific. */
export function kindForStatus(status: number): ErrorKind {
  if (status === 401) return 'auth';
  if (status === 408 || status === 429 || status >= 500) return 'retryable';
  return 'rejected';
}
