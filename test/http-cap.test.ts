import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { capResponses, jsonOr } from '../src/core/http.ts';

const stream = (chunks: number, size: number) =>
  new ReadableStream<Uint8Array>({
    pull(c) {
      if (chunks-- <= 0) return c.close();
      c.enqueue(new Uint8Array(size).fill(0x61));
    },
  });

describe('response size cap', () => {
  it('passes ordinary answers through unchanged', async () => {
    const fetch = capResponses(async () => new Response(JSON.stringify({ ok: true }), { status: 201, headers: { 'x-restli-id': 'urn:1' } }), 1024);
    const res = await fetch('https://api.example/');
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('x-restli-id'), 'urn:1');
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal((await capResponses(async () => new Response(null, { status: 204 }), 1024)('https://api.example/')).status, 204);
  });

  it('stops a body that says or turns out to be too large', async () => {
    const declared = capResponses(async () => new Response(stream(1, 10), { headers: { 'content-length': String(5000) } }), 1024);
    await assert.rejects(declared('https://evil.example/'), /너무 큽니다/);
    // An endless body without a length: reading fails once past the cap instead of filling memory.
    // Bounded, so a regression fails the assertion instead of hanging.
    const endless = capResponses(async () => new Response(stream(64, 512)), 1024);
    const res = await endless('https://evil.example/');
    await assert.rejects(res.text(), /너무 큽니다/);
  });

  it('an oversized body is an error, not an empty answer', async () => {
    const res = await capResponses(async () => new Response(stream(64, 512)), 1024)('https://evil.example/');
    await assert.rejects(jsonOr(res, {}), /너무 큽니다/);
    assert.deepEqual(await jsonOr(new Response('not json'), { fallback: true }), { fallback: true });
  });
});
