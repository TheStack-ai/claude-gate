import assert from 'node:assert/strict';
import test from 'node:test';

import { RetryResponseCache, requestIdFromHeaders } from '../src/cache.mjs';

function createNowSequence(...values) {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };
}

test('requestIdFromHeaders reads x-client-request-id', () => {
  assert.equal(requestIdFromHeaders({ 'x-client-request-id': 'req-1' }), 'req-1');
  assert.equal(requestIdFromHeaders({ 'X-Client-Request-Id': ['req-2'] }), 'req-2');
  assert.equal(requestIdFromHeaders({}), null);
});

test('RetryResponseCache returns cloned cached response and logs hits', () => {
  const hits = [];
  const cache = new RetryResponseCache({
    now: createNowSequence(100, 150, 200),
    log: {
      info(message, payload) {
        hits.push({ message, payload });
      },
    },
  });

  cache.set('req-1', {
    statusCode: 200,
    headers: {
      'content-type': 'application/json',
    },
    body: Buffer.from('ok'),
  });

  const cached = cache.get('req-1');
  assert.equal(cached.statusCode, 200);
  assert.equal(cached.body.toString('utf8'), 'ok');

  cached.headers['content-type'] = 'text/plain';
  cached.body.write('x');

  const secondRead = cache.get('req-1');
  assert.equal(secondRead.headers['content-type'], 'application/json');
  assert.equal(secondRead.body.toString('utf8'), 'ok');
  assert.equal(hits.length, 2);
  assert.equal(hits[0].payload.request_id, 'req-1');
});

test('RetryResponseCache evicts LRU entries when over capacity', () => {
  const cache = new RetryResponseCache({
    maxEntries: 2,
    ttlMs: 5000,
    now: createNowSequence(0, 0, 10, 10, 20, 20, 30, 30, 40, 40),
  });

  cache.set('req-1', { statusCode: 200, headers: {}, body: 'a' });  // now: 0, 0
  cache.set('req-2', { statusCode: 200, headers: {}, body: 'b' });  // now: 10, 10
  assert.equal(cache.get('req-1').body, 'a');                        // now: 20, 20 — bumps req-1 to MRU

  cache.set('req-3', { statusCode: 200, headers: {}, body: 'c' });  // now: 30, 30 — evicts req-2 (LRU)
  assert.equal(cache.get('req-2'), null);                            // now: 40, 40 — evicted
  assert.notEqual(cache.get('req-3'), null);                         // req-3 still present
});

test('RetryResponseCache expires entries after TTL', () => {
  const cache = new RetryResponseCache({
    maxEntries: 10,
    ttlMs: 50,
    now: createNowSequence(0, 0, 100, 100),
  });

  cache.set('req-1', { statusCode: 200, headers: {}, body: 'a' });  // storedAt: 0
  assert.equal(cache.get('req-1'), null);                            // now: 100, cutoff: 50 → expired
});
