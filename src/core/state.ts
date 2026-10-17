import type { TargetState } from './types.ts';

const TRANSITIONS: Record<TargetState, readonly TargetState[]> = {
  queued: ['transcoding', 'uploading', 'failed', 'needs_reauth'],
  // transcoding/uploading → queued: a retryable failure waits for its backoff and goes again.
  transcoding: ['uploading', 'queued', 'failed'],
  uploading: ['processing', 'published', 'handed_off', 'queued', 'failed', 'needs_reauth'],
  processing: ['published', 'handed_off', 'failed', 'needs_reauth'],
  published: ['removed'],
  handed_off: [],
  failed: ['queued'],
  needs_reauth: ['queued'],
  removed: [],
};

export const TERMINAL_STATES: readonly TargetState[] = ['published', 'handed_off', 'failed', 'needs_reauth', 'removed'];

export function isTerminal(state: TargetState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function canTransition(from: TargetState, to: TargetState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TargetState, to: TargetState): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal target state transition ${from} → ${to}`);
  }
}
