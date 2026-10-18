import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { namedOrOnly } from '../src/cli.ts';
import { redirectParams, waitForRedirect } from '../src/core/http.ts';
import { makeCtx } from './helpers.ts';

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
