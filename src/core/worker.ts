import { refreshStats } from './posting.ts';
import { settle, type RunnerDeps } from './runner.ts';
import { refreshDueStats } from './stats.ts';
import { verifyDueAccounts, warnExpiringAccounts } from './accounts.ts';
import { sendWeeklyDigest } from './digest.ts';
import { postDueFirstComments } from './followup.ts';
import { msg } from './i18n.ts';
import { notifyEvent } from './notify.ts';

export const DEFAULT_STATS_EVERY_MS = 6 * 3600_000;
const STATS_CHECK_MS = 30 * 60_000;
const STATS_FIRST_MS = 60_000;
/** An error from SQLite itself (full disk, I/O, locked past the busy timeout), not from a platform. */
function isStoreError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ERR_SQLITE_ERROR';
}

/** Ticks that fail in a row before health() reports it, and before one alert goes out. */
const TICK_FAILURES_UNHEALTHY = 3;
const TICK_FAILURES_ALERT = 5;

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
  #statsFirst?: NodeJS.Timeout;
  #statsRun?: Promise<number>;
  #upkeepTimer?: NodeJS.Timeout;
  #upkeepFirst?: NodeJS.Timeout;
  #upkeepRun?: Promise<number>;
  #followupRun?: Promise<number>;
  #tickFailures = 0;
  #lastGoodTick: number;
  #storeError?: string;

  constructor(deps: RunnerDeps, opts: WorkerOptions = {}) {
    this.#deps = deps;
    this.#opts = opts;
    this.#lastGoodTick = deps.ctx.now().getTime();
  }

  start(): void {
    this.#timer = setInterval(() => this.tick(), this.#opts.intervalMs ?? 15_000);
    this.tick();
    if (this.#statsEvery() > 0) {
      // First look a minute after start (short-lived MCP sessions too), then every half hour.
      this.#statsFirst = setTimeout(() => void this.statsTick(), STATS_FIRST_MS);
      this.#statsFirst.unref();
      this.#statsTimer = setInterval(() => void this.statsTick(), STATS_CHECK_MS);
      this.#statsTimer.unref();
    }
    // Account checks some platforms' terms require (core/accounts.ts); each account at most daily.
    this.#upkeepFirst = setTimeout(() => void this.upkeepTick(), STATS_FIRST_MS);
    this.#upkeepFirst.unref();
    this.#upkeepTimer = setInterval(() => void this.upkeepTick(), STATS_CHECK_MS);
    this.#upkeepTimer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
    clearInterval(this.#statsTimer);
    clearTimeout(this.#statsFirst);
    clearInterval(this.#upkeepTimer);
    clearTimeout(this.#upkeepFirst);
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

  /** Verify accounts that are due; one run at a time. Resolves to how many were checked. */
  upkeepTick(): Promise<number> {
    if (this.#upkeepRun) return this.#upkeepRun;
    const { ctx, providers } = this.#deps;
    this.#upkeepRun = verifyDueAccounts(ctx, providers)
      .then(async (n) => {
        await warnExpiringAccounts(ctx, providers);
        sendWeeklyDigest(ctx, providers);
        return n;
      })
      .catch((err: unknown) => {
        ctx.log.warn(`verify: ${String(err)}`);
        return 0;
      })
      .finally(() => {
        this.#upkeepRun = undefined;
      });
    return this.#upkeepRun;
  }

  /** First comments of targets just published; one run at a time. Resolves to how many were tried. */
  followupTick(): Promise<number> {
    if (this.#followupRun) return this.#followupRun;
    const { ctx, providers } = this.#deps;
    this.#followupRun = postDueFirstComments(ctx, providers)
      .catch((err: unknown) => {
        ctx.log.warn(`first comment: ${String(err)}`);
        return 0;
      })
      .finally(() => {
        this.#followupRun = undefined;
      });
    return this.#followupRun;
  }

  /** Wait for in-flight runner work (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.#running.size) await Promise.all(this.#running);
    await this.#statsRun;
    await this.#upkeepRun;
    await this.#followupRun;
  }

  /**
   * Whether the loop is doing its job: ticks that can't read the database (full disk, I/O error,
   * locked past the busy timeout) are logged and retried. It is unhealthy after a few failed ticks
   * in a row, or when no tick has succeeded for three intervals (a loop that stopped running), and
   * the dashboard's /healthz answers 503 so a container or service manager sees it.
   */
  health(): { ok: boolean } {
    const since = this.#deps.ctx.now().getTime() - this.#lastGoodTick;
    return { ok: this.#tickFailures < TICK_FAILURES_UNHEALTHY && since < 3 * this.#interval() };
  }

  #interval(): number {
    return this.#opts.intervalMs ?? 15_000;
  }

  tick(): void {
    void this.followupTick();
    let workable: ReturnType<RunnerDeps['ctx']['store']['workableTargets']> | undefined;
    const { ctx } = this.#deps;
    // A database error in the runs since the last tick (a full disk usually lets reads through and
    // fails the writes) counts as much as this tick's own read failing.
    let error = this.#storeError;
    this.#storeError = undefined;
    try {
      workable = ctx.store.workableTargets();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    if (error === undefined) {
      this.#tickFailures = 0;
      this.#lastGoodTick = ctx.now().getTime();
    } else {
      this.#tickFailures++;
      ctx.log.warn(msg('작업 처리기가 데이터베이스를 읽지 못했습니다 ({n}번 연속): {error}', { n: this.#tickFailures, error }));
      // One alert per stall: the next one only after a good tick in between. (When the store itself
      // is what fails, the webhook setting may not be readable either; /healthz still says so.)
      if (this.#tickFailures === TICK_FAILURES_ALERT) {
        try {
          notifyEvent(ctx, 'alert', msg('fanout 작업 처리기가 멈췄습니다: 데이터베이스 오류가 계속됩니다 — {error}', { error }), { worker: 'stalled' });
        } catch {
          // nothing more to do: the warning above and /healthz remain
        }
      }
    }
    if (!workable) return;
    const byPlatform = new Map<string, string[]>();
    for (const t of workable) {
      if (this.#busyPlatforms.has(t.platform)) continue;
      byPlatform.set(t.platform, [...(byPlatform.get(t.platform) ?? []), t.id]);
    }
    for (const [platform, ids] of byPlatform) {
      this.#busyPlatforms.add(platform);
      const run = settle(this.#deps, ids, { pollIntervalMs: this.#opts.pollIntervalMs ?? 10_000, timeoutMs: 10 * 60_000 })
        .catch((err: unknown) => {
          this.#deps.ctx.log.warn(`worker(${platform}): ${String(err)}`);
          // The store failing under a run (claim, transition): counted at the next tick.
          if (isStoreError(err)) this.#storeError = err instanceof Error ? err.message : String(err);
        })
        .finally(() => {
          this.#busyPlatforms.delete(platform);
          this.#running.delete(run);
        });
      this.#running.add(run);
    }
  }
}
