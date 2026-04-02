import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import test from 'node:test';

import { createRequestClassifier } from '../src/classifier.mjs';
import { MetricsLogger } from '../src/logger.mjs';
import { startProxyServer } from '../src/proxy.mjs';

function createNowSequence(...values) {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(server.address());
    });
  });
}

function request({ port, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            body: Buffer.concat(chunks),
          });
        });
      },
    );

    req.on('error', reject);
    req.end(body);
  });
}

test('classifier parses query source, retry, and shadow eligibility without mutating raw bytes', () => {
  const classifier = createRequestClassifier({ now: createNowSequence(1, 2) });
  const rawBody = Buffer.from(JSON.stringify({
    model: 'claude-opus-4-6',
    tools: [{ name: 'Read' }, { name: 'Edit' }],
    messages: [{ role: 'user', content: 'hello' }],
    metadata: {
      user_id: JSON.stringify({ querySource: 'agent:custom' }),
    },
  }));
  const originalBody = Buffer.from(rawBody);
  const headers = {
    'x-client-request-id': 'req-123',
    'x-claude-code-session-id': 'session-1',
  };

  const first = classifier.classify({ headers, bodyBuffer: rawBody });
  const second = classifier.classify({ headers, bodyBuffer: rawBody });

  assert.deepEqual(rawBody, originalBody);
  assert.equal(first.querySource, 'agent:custom');
  assert.equal(first.toolCount, 2);
  assert.equal(first.messageCount, 1);
  assert.equal(first.isRetry, false);
  assert.equal(second.isRetry, true);
  assert.equal(first.shadowEligible, true);
  assert.equal(first.thinking, false);
});

test('logger writes per-turn metrics and session aggregates from SSE events', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'claude-proxy-logger-'));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const logPath = path.join(tempDir, 'metrics.jsonl');
  const logger = new MetricsLogger({
    logPath,
    now: createNowSequence(1100, 1400),
  });

  const turn = logger.createTurnContext({
    sessionId: 'session-1',
    requestId: 'req-1',
    requestStartedAt: 1000,
  });

  turn.setClassification({
    querySource: 'agent:custom',
    model: 'claude-opus-4-6',
    toolCount: 2,
    messageCount: 3,
    isRetry: false,
    speed: 'fast',
    thinking: false,
  });

  turn.setResponseInfo({
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
    },
  });

  turn.observeChunk(Buffer.from(
    'event: message_start\n' +
      'data: {"type":"message_start","message":{"model":"claude-opus-4-6","usage":{"input_tokens":100,"cache_read_input_tokens":80,"cache_creation_input_tokens":20}}}\n\n',
  ));
  const record = await turn.finalize({ status: 200 });

  turn.observeChunk(Buffer.from(
    'event: message_delta\n' +
      'data: {"type":"message_delta","usage":{"output_tokens":30}}\n\n',
  ));

  const logLines = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(logLines.length, 1);
  const logged = logLines[0];

  assert.equal(record.session_id, 'session-1');
  assert.equal(logged.input_tokens, 100);
  assert.equal(logged.cache_read, 80);
  assert.equal(logged.cache_write, 20);
  assert.equal(logged.output_tokens, 0);
  assert.equal(logged.ttfb_ms, 100);
  assert.equal(logged.duration_ms, 400);
  assert.equal(logged.total_input_tokens, 100);
  assert.equal(logged.agent_request_ratio, 1);
});

test('proxy forwards raw body unchanged and tees SSE metrics without buffering', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'claude-proxy-proxy-'));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const logPath = path.join(tempDir, 'metrics.jsonl');
  const logger = new MetricsLogger({ logPath });

  let upstreamBody = null;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      upstreamBody = Buffer.concat(chunks);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        'event: message_start\n' +
          'data: {"type":"message_start","message":{"model":"claude-opus-4-6","usage":{"input_tokens":12,"cache_read_input_tokens":4,"cache_creation_input_tokens":2}}}\n\n',
      );
      res.end(
        'event: message_delta\n' +
          'data: {"type":"message_delta","usage":{"output_tokens":6}}\n\n',
      );
    });
  });

  const upstreamAddress = await listen(upstream);
  t.after(async () => {
    await new Promise((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
    });
  });

  const proxy = await startProxyServer({
    port: 0,
    logger,
    config: {
      anthropic: {
        base_url: `http://127.0.0.1:${upstreamAddress.port}`,
      },
    },
    log: {
      info() {},
      error() {},
    },
  });

  t.after(async () => {
    await proxy.shutdown('test');
  });

  const body = JSON.stringify({
    model: 'claude-opus-4-6',
    stream: true,
    tools: [{ name: 'Read' }],
    messages: [{ role: 'user', content: 'hello' }],
    metadata: {
      user_id: JSON.stringify({ querySource: 'agent:default' }),
    },
  });

  const response = await request({
    port: proxy.port,
    body,
    headers: {
      'x-client-request-id': 'req-1',
      'x-claude-code-session-id': 'session-1',
    },
  });

  await logger.close();

  assert.equal(response.statusCode, 200);
  assert.equal(upstreamBody.toString('utf8'), body);
  assert.match(response.body.toString('utf8'), /message_start/);
  assert.match(response.body.toString('utf8'), /message_delta/);

  const logLines = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const logged = logLines.at(-1);
  assert.equal(logged.query_source, 'agent:default');
  assert.equal(logged.routed_to, 'anthropic');
  assert.equal(logged.input_tokens, 12);
  assert.equal(logged.output_tokens, 6);
  assert.equal(logged.tool_count, 1);
});
