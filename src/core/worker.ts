import { settle, type RunnerDeps } from './runner.ts';

export interface WorkerOptions {
  intervalMs?: number;
  pollIntervalMs?: number;
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

  constructor(deps: RunnerDeps, opts: WorkerOptions = {}) {
    this.#deps = deps;
    this.#opts = opts;
  }

  start(): void {
    this.#timer = setInterval(() => this.tick(), this.#opts.intervalMs ?? 15_000);
    this.tick();
  }

  stop(): void {
    clearInterval(this.#timer);
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
