import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import type { Provider } from '../src/core/provider.ts';
import { step, type RunnerDeps } from '../src/core/runner.ts';
import type { PostInput } from '../src/core/types.ts';
import { Worker } from '../src/core/worker.ts';
import { Dashboard } from '../src/server/server.ts';
import { fakeMedia, makeCtx } from './helpers.ts';

const POST: PostInput = { mediaPath: '/v.mp4', title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false };
const RENEW_MS = 5 * 60_000;

/** Publishes with two platform requests; the first waits until `open()` is called. */
function twoRequestProvider() {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const p = {
    id: 'fake',
    displayName: 'Fake',
    capabilities: { nativeSchedule: false, thumbnail: false, captions: false, syntheticMediaFlag: false },
    spec: {},
    appFields: [],
    connectMethod: 'token' as const,
    setupGuide: () => '',
    connect: async () => {
      throw new Error('n/a');
    },
    refresh: async (_c: unknown, a: never) => a,
    validate: () => [],
    publish: async ({ ctx }: { ctx: { fetch: typeof fetch } }) => {
      await ctx.fetch('https://fake.example/1');
      await ctx.fetch('https://fake.example/2');
      return { state: 'published' as const, remoteId: 'R' };
    },
    poll: async () => ({ state: 'published' as const, remoteId: 'R' }),
    doctor: async () => [],
  };
  return { provider: p as unknown as Provider, open: () => open(), gate };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setImmediate(r));
  assert.ok(cond(), 'condition never became true');
};

describe('worker guards', () => {
  it('a tick that cannot read the database is logged, retried, and shows on /healthz', async () => {
    const env = makeCtx();
    const warnings: string[] = [];
    env.ctx.log = { ...env.ctx.log, warn: (m: string) => warnings.push(m) };
    const real = env.store.workableTargets.bind(env.store);
    let failing = true;
    env.store.workableTargets = () => {
      if (failing) throw new Error('SQLITE_FULL: database or disk is full');
      return real();
    };
    const dashboard = new Dashboard({ ctx: env.ctx, providers: new Map(), port: 0, workerIntervalMs: 3_600_000 });
    const base = (await dashboard.start()).replace(/\/$/, '');
    try {
      for (let i = 0; i < 4; i++) dashboard.tick();
      assert.ok(warnings.some((w) => /SQLITE_FULL/.test(w)));
      const sick = await fetch(`${base}/healthz`);
      assert.equal(sick.status, 503);
      assert.match(JSON.stringify(await sick.json()), /SQLITE_FULL/);
      failing = false;
      dashboard.tick();
      assert.equal((await fetch(`${base}/healthz`)).status, 200);
    } finally {
      await dashboard.stop();
    }
  });

  it('one failing tick is not unhealthy', () => {
    const env = makeCtx();
    env.ctx.log = { ...env.ctx.log, warn: () => {} };
    const worker = new Worker({ ctx: env.ctx, providers: new Map() });
    const real = env.store.workableTargets.bind(env.store);
    let n = 0;
    env.store.workableTargets = () => (n++ === 0 ? (() => { throw new Error('SQLITE_BUSY'); })() : real());
    worker.tick();
    assert.equal(worker.health().ok, true);
    worker.tick();
    assert.equal(worker.health().ok, true);
  });

  it('when renewing the lease keeps failing, the step sends no new request but lets the current one finish', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      const sent: string[] = [];
      const { provider, open, gate } = twoRequestProvider();
      const env = makeCtx((async (url: string | URL) => {
        sent.push(String(url));
        if (String(url).endsWith('/1')) await gate;
        return new Response('{}');
      }) as typeof fetch);
      env.ctx.log = { ...env.ctx.log, warn: () => {} };
      env.store.saveAccount({ platform: 'fake', name: 'main', credentials: {}, profile: {} });
      const { targets } = env.store.createPost(POST, [{ platform: 'fake', account: 'main', options: {} }]);
      const id = targets[0]!.id;
      const deps: RunnerDeps = { ctx: env.ctx, providers: new Map([['fake', provider]]), probe: async () => fakeMedia(), ensureVariant: async (info) => ({ path: info.path, transcoded: false, reasons: [] }) };
      const running = step(deps, id);
      await until(() => sent.length === 1);
      const claim = env.store.claim.bind(env.store);
      env.store.claim = () => {
        throw new Error('SQLITE_IOERR');
      };
      for (let i = 0; i < 3; i++) mock.timers.tick(RENEW_MS);
      env.store.claim = claim;
      open();
      const t = await running;
      assert.deepEqual(sent, ['https://fake.example/1'], 'the in-flight request finished; the next was never sent');
      assert.equal(t.state, 'queued');
      assert.match(t.errorCode ?? '', /lease_lost/);
    } finally {
      mock.timers.reset();
    }
  });

  it('when another process holds the lease, the step stops at the next request', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      const sent: string[] = [];
      const { provider, open, gate } = twoRequestProvider();
      const env = makeCtx((async (url: string | URL) => {
        sent.push(String(url));
        if (String(url).endsWith('/1')) await gate;
        return new Response('{}');
      }) as typeof fetch);
      env.ctx.log = { ...env.ctx.log, warn: () => {} };
      env.store.saveAccount({ platform: 'fake', name: 'main', credentials: {}, profile: {} });
      const { targets } = env.store.createPost(POST, [{ platform: 'fake', account: 'main', options: {} }]);
      const id = targets[0]!.id;
      const deps: RunnerDeps = { ctx: env.ctx, providers: new Map([['fake', provider]]), probe: async () => fakeMedia(), ensureVariant: async (info) => ({ path: info.path, transcoded: false, reasons: [] }) };
      const running = step(deps, id);
      await until(() => sent.length === 1);
      env.store.claim = () => false;
      mock.timers.tick(RENEW_MS);
      open();
      await running;
      assert.deepEqual(sent, ['https://fake.example/1']);
    } finally {
      mock.timers.reset();
    }
  });
});
