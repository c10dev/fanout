import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Dashboard } from '../src/server/server.ts';
import { makeCtx } from './helpers.ts';

describe('dashboard drafts', () => {
  it('says whether an uploaded video is still on the server', async () => {
    const { ctx } = makeCtx();
    const dashboard = new Dashboard({ ctx, providers: new Map(), port: 0, workerIntervalMs: 3_600_000 });
    const base = (await dashboard.start()).replace(/\/$/, '');
    const headers = { 'x-fanout-token': dashboard.token, 'x-fanout-lang': 'en' };
    try {
      const id = '0f8fad5b-d9cb-469f-a165-70867728950e.mp4';
      mkdirSync(join(ctx.home, 'media'), { recursive: true });
      writeFileSync(join(ctx.home, 'media', id), 'x');
      const ok = await fetch(`${base}/api/media/${id}`, { headers });
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { id });
      const gone = await fetch(`${base}/api/media/1f8fad5b-d9cb-469f-a165-70867728950e.mp4`, { headers });
      assert.equal(gone.status, 404);
      assert.match(((await gone.json()) as { error: string }).error, /no longer on the server/);
      // Not an upload id: never a path outside the media folder.
      assert.equal((await fetch(`${base}/api/media/..%2Ffanout.db`, { headers })).status, 404);
    } finally {
      await dashboard.stop();
    }
  });
});
