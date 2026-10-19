import assert from 'node:assert/strict';
import { get } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { namedOrOnly } from '../src/cli.ts';
import { redirectParams, startLoopback, waitForRedirect } from '../src/core/http.ts';
import { msg } from '../src/core/i18n.ts';
import { makeCtx } from './helpers.ts';

/** One request on a connection of its own, so close() is not held up by a kept-alive socket. */
function hit(url: string): Promise<{ status: number; type?: string; body: string }> {
  return new Promise((resolve, reject) => {
    get(url, { agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'], body }));
    }).on('error', reject);
  });
}

/** A plain TCP server holding some free port on 127.0.0.1. */
async function takePort() {
  const server = createServer();
  await new Promise<void>((r, j) => server.once('error', j).listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('OAuth redirect from a browser on another machine', () => {
  it('takes a pasted redirect address while the loopback waits', async () => {
    const input = new PassThrough();
    const logs: string[] = [];
    const never = new Promise<URLSearchParams>(() => {});
    const got = waitForRedirect(never, (l) => logs.push(l), input);
    input.write('hello\n');
    input.write('  http://127.0.0.1:8723/callback?code=AB%2Ac&scopes=video.list&state=S1  \n');
    const params = await got;
    assert.deepEqual([params.get('code'), params.get('state')], ['AB*c', 'S1']);
    assert.equal(logs.length, 2, 'the hint, then "not a redirect URL" for the stray line');
    assert.match(logs[0]!, /붙여넣으세요/);
  });

  it('still finishes on the loopback when the browser reaches it', async () => {
    const input = new PassThrough();
    const params = await waitForRedirect(Promise.resolve(new URLSearchParams('code=X&state=S')), () => {}, input);
    assert.equal(params.get('code'), 'X');
  });

  it('knows a redirect when it sees one', () => {
    assert.equal(redirectParams('https://example.com/cb?error=access_denied')?.get('error'), 'access_denied');
    assert.equal(redirectParams('https://example.com/cb?state=S'), undefined);
    assert.equal(redirectParams('not a url'), undefined);
  });
});

describe('the OAuth loopback listener', () => {
  it('port 0 takes a free port and the redirect URI names it', async () => {
    const loop = await startLoopback(0);
    try {
      const m = /^http:\/\/127\.0\.0\.1:(\d+)\/callback$/.exec(loop.redirectUri);
      assert.ok(m && Number(m[1]) > 0, loop.redirectUri);
    } finally {
      loop.close();
    }
  });

  it('answers 404 to another path and keeps waiting for the callback', async () => {
    const loop = await startLoopback(0, '/oauth/cb');
    try {
      const base = new URL(loop.redirectUri).origin;
      assert.equal((await hit(`${base}/favicon.ico`)).status, 404);
      assert.equal((await hit(`${base}/callback?code=WRONG&state=S`)).status, 404, 'only the path asked for');
      const page = await hit(`${loop.redirectUri}?code=RIGHT&state=S`);
      assert.deepEqual([page.status, page.type, page.body], [200, 'text/html; charset=utf-8', msg('<p>fanout: 인증이 끝났습니다. 이 창을 닫고 터미널로 돌아가세요.</p>')]);
      const params = await loop.waitForCallback;
      assert.deepEqual([params.get('code'), params.get('state')], ['RIGHT', 'S'], 'a 404 never resolved it');
    } finally {
      loop.close();
    }
  });

  it('close() frees the port for the next connect', async () => {
    const loop = await startLoopback(0);
    const port = Number(new URL(loop.redirectUri).port);
    await hit(`${loop.redirectUri}?code=C`);
    loop.close();
    await new Promise((r) => setImmediate(r));
    const again = await startLoopback(port);
    try {
      assert.equal(again.redirectUri, loop.redirectUri);
    } finally {
      again.close();
    }
  });

  // Without the error listener the listen never settled and the run hung: fail fast instead.
  it('fails instead of crashing when the port is taken', { timeout: 5_000 }, async () => {
    const taken = await takePort();
    try {
      await assert.rejects(startLoopback(taken.port), (e: NodeJS.ErrnoException) => e.code === 'EADDRINUSE');
    } finally {
      await taken.close();
    }
  });
});

describe('the account a command means', () => {
  it('main, else the only one, and asks when there are several', () => {
    const { ctx, store } = makeCtx();
    const save = (name: string) => store.saveAccount({ platform: 'tiktok', name, credentials: {}, profile: {} });
    assert.equal(namedOrOnly(ctx, 'tiktok', undefined, '--name'), 'main', 'none yet: a new "main"');
    save('mainmain');
    assert.equal(namedOrOnly(ctx, 'tiktok', undefined, '--account'), 'mainmain');
    save('second');
    assert.throws(() => namedOrOnly(ctx, 'tiktok', undefined, '--account'), /mainmain, second.*--account/);
    assert.equal(namedOrOnly(ctx, 'tiktok', 'second', '--account'), 'second');
    save('main');
    assert.equal(namedOrOnly(ctx, 'tiktok', undefined, '--account'), 'main');
  });
});
