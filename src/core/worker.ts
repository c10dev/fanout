import { refreshStats } from './posting.ts';
import { settle, type RunnerDeps } from './runner.ts';
import { refreshDueStats } from './stats.ts';

export const DEFAULT_STATS_EVERY_MS = 6 * 3600_000;
const STATS_CHECK_MS = 30 * 60_000;

export interface WorkerOptions {
  intervalMs?: number;
  pollIntervalMs?: number;
  /** Re-read stats of posts from the last 30 days this often (default 6 hours); 0 turns it off. */
  statsEveryMs?: number;
}

/**
 * Background loop shared by the dashboard and the MCP server: every interval, start one runner per
 * idle platform over its due targets, so a platform never uploads two things at once. Leases (see
 * runner.step) keep other processes from picking up the same targets.
 */
export class Worker {
  readonly #deps: RunnerDeps;
  readonly #opts: WorkerOptions;
  readonly #busyPlatforms = new Set<string>();
  readonly #running = new Set<Promise<unknown>>();
  #timer?: NodeJS.Timeout;
  #statsTimer?: NodeJS.Timeout;
  #statsRun?: Promise<number>;

  constructor(deps: RunnerDeps, opts: WorkerOptions = {}) {
    this.#deps = deps;
    this.#opts = opts;
  }

  start(): void {
    this.#timer = setInterval(() => this.tick(), this.#opts.intervalMs ?? 15_000);
    this.tick();
    if (this.#statsEvery() > 0) {
      this.#statsTimer = setInterval(() => void this.statsTick(), STATS_CHECK_MS);
      this.#statsTimer.unref();
    }
  }

  stop(): void {
    clearInterval(this.#timer);
    clearInterval(this.#statsTimer);
  }

  #statsEvery(): number {
    return this.#opts.statsEveryMs ?? DEFAULT_STATS_EVERY_MS;
  }

  /** Refresh stats that are due; one run at a time. Resolves to how many targets were refreshed. */
  statsTick(): Promise<number> {
    if (this.#statsRun) return this.#statsRun;
    const { ctx, providers } = this.#deps;
    this.#statsRun = refreshDueStats(ctx, providers, (postId, platform) => refreshStats(ctx, providers, postId, { platform }), { everyMs: this.#statsEvery() })
      .catch((err: unknown) => {
        ctx.log.warn(`stats: ${String(err)}`);
        return 0;
      })
      .finally(() => {
        this.#statsRun = undefined;
      });
    return this.#statsRun;
  }

  /** Wait for in-flight runner work (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.#running.size) await Promise.all(this.#running);
  }

  tick(): void {
    const byPlatform = new Map<string, string[]>();
    for (const t of this.#deps.ctx.store.workableTargets()) {
      if (this.#busyPlatforms.has(t.platform)) continue;
      byPlatform.set(t.platform, [...(byPlatform.get(t.platform) ?? []), t.id]);
    }
    for (const [platform, ids] of byPlatform) {
      this.#busyPlatforms.add(platform);
      const run = settle(this.#deps, ids, { pollIntervalMs: this.#opts.pollIntervalMs ?? 10_000, timeoutMs: 10 * 60_000 })
        .catch((err: unknown) => this.#deps.ctx.log.warn(`worker(${platform}): ${String(err)}`))
        .finally(() => {
          this.#busyPlatforms.delete(platform);
          this.#running.delete(run);
        });
      this.#running.add(run);
    }
  }
}
