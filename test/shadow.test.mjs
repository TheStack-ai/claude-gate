import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import test from 'node:test';

import { ShadowEvaluator, createShadowEvaluator } from '../src/shadow.mjs';

const silentLog = { info() {}, error() {} };

function makeClassification(overrides = {}) {
  return {
    sessionId: 'session-1',
    requestId: 'req-1',
    querySource: 'agent:custom',
    model: 'claude-opus-4-6',
    toolCount: 2,
    shadowEligible: true,
    ...overrides,
  };
}

function makeBody(overrides = {}) {
  return Buffer.from(JSON.stringify({
    model: 'claude-opus-4-6',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    metadata: { user_id: '{"querySource":"agent:custom"}' },
    ...overrides,
  }));
}

test('isEnabled returns false when shadow.enabled is false', () => {
  const evaluator = createShadowEvaluator({
    config: { shadow: { enabled: false }, openai: {} },
  });
  assert.equal(evaluator.isEnabled(), false);
});

test('isEnabled returns false when OPENAI_API_KEY is not set', () => {
  const origKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  try {
    const evaluator = createShadowEvaluator({
      config: { shadow: { enabled: true }, openai: { api_key_env: 'OPENAI_API_KEY' } },
    });
    assert.equal(evaluator.isEnabled(), false);
  } finally {
    if (origKey !== undefined) {
      process.env.OPENAI_API_KEY = origKey;
    }
  }
});

test('isEnabled returns true when shadow enabled and API key present', () => {
  const origKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';

  try {
    const evaluator = createShadowEvaluator({
      config: { shadow: { enabled: true }, openai: { api_key_env: 'OPENAI_API_KEY' } },
    });
    assert.equal(evaluator.isEnabled(), true);
  } finally {
    if (origKey !== undefined) {
      process.env.OPENAI_API_KEY = origKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  }
});

test('maybeStart returns null when not eligible', () => {
  const origKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';

  try {
    const evaluator = createShadowEvaluator({
      config: { shadow: { enabled: true }, openai: {} },
      log: silentLog,
    });

    const ctx = evaluator.maybeStart(
      makeClassification({ shadowEligible: false }),
      makeBody(),
    );
    assert.equal(ctx, null);
  } finally {
    if (origKey !== undefined) {
      process.env.OPENAI_API_KEY = origKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  }
});

test('maybeStart returns context when eligible', () => {
  const origKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';

  try {
    const evaluator = createShadowEvaluator({
      config: { shadow: { enabled: true }, openai: { base_url: 'http://localhost:1' } },
      log: silentLog,
      fetchCodex: () => Promise.resolve(null),
    });

    const ctx = evaluator.maybeStart(makeClassification(), makeBody());
    assert.notEqual(ctx, null);
    assert.equal(typeof ctx.observeChunk, 'function');
    assert.equal(typeof ctx.complete, 'function');
  } finally {
    if (origKey !== undefined) {
      process.env.OPENAI_API_KEY = origKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  }
});

test('shadow logs ok result with divergence on tool_choice', async (t) => {
  const origKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'shadow-test-'));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
    if (origKey !== undefined) {
      process.env.OPENAI_API_KEY = origKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  const logPath = path.join(tempDir, 'shadow.jsonl');
  let timeValue = 1000;

  const evaluator = new ShadowEvaluator({
    config: { shadow: { enabled: true }, openai: { default_model: 'gpt-5.4' } },
    logPath,
    log: silentLog,
    now: () => timeValue++,
    fetchCodex: () => Promise.resolve({
      model: 'gpt-5.4',
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'Write', arguments: '{}' },
          }],
        },
      }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }),
  });

  const ctx = evaluator.maybeStart(makeClassification(), makeBody());

  // Feed Anthropic SSE response showing tool_use of "Read"
  ctx.observeChunk(Buffer.from(
    'event: content_block_start\n' +
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"Read","input":{}}}\n\n',
  ));

  // Complete and wait for async logging
  ctx.complete();
  await new Promise(r => setTimeout(r, 50));

  const lines = (await readFile(logPath, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.length, 1);
  const record = lines[0];
  assert.equal(record.status, 'ok');
  assert.equal(record.session_id, 'session-1');
  assert.equal(record.request_id, 'req-1');
  assert.equal(record.model_codex, 'gpt-5.4');
  assert.equal(record.divergences.length, 1);
  assert.equal(record.divergences[0].divergence_type, 'tool_choice');
  assert.equal(record.divergences[0].anthropic_tool, 'Read');
  assert.equal(record.divergences[0].codex_tool, 'Write');
});

test('shadow logs ok result with content divergence', async (t) => {
  const origKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'shadow-test-'));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
    if (origKey !== undefined) {
      process.env.OPENAI_API_KEY = origKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  const logPath = path.join(tempDir, 'shadow.jsonl');

  const evaluator = new ShadowEvaluator({
    config: { shadow: { enabled: true }, openai: { default_model: 'gpt-5.4' } },
    logPath,
    log: silentLog,
    now: () => 1000,
    fetchCodex: () => Promise.resolve({
      model: 'gpt-5.4',
      choices: [{ message: { content: 'completely different response text here' } }],
      usage: {},
    }),
  });

  const ctx = evaluator.maybeStart(makeClassification(), makeBody());

  ctx.observeChunk(Buffer.from(
    'event: content_block_delta\n' +
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello world"}}\n\n',
  ));

  ctx.complete();
  await new Promise(r => setTimeout(r, 50));

  const lines = (await readFile(logPath, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  const record = lines[0];
  assert.equal(record.status, 'ok');
  const contentDiv = record.divergences.find(d => d.divergence_type === 'output_content');
  assert.ok(contentDiv);
  assert.ok(contentDiv.similarity_score < 1);
});

test('shadow logs error when codex returns null', async (t) => {
  const origKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'shadow-test-'));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
    if (origKey !== undefined) {
      process.env.OPENAI_API_KEY = origKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  const logPath = path.join(tempDir, 'shadow.jsonl');

  const evaluator = new ShadowEvaluator({
    config: { shadow: { enabled: true }, openai: {} },
    logPath,
    log: silentLog,
    now: () => 1000,
    fetchCodex: () => Promise.resolve(null),
  });

  const ctx = evaluator.maybeStart(makeClassification(), makeBody());
  ctx.complete();
  await new Promise(r => setTimeout(r, 50));

  const lines = (await readFile(logPath, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines[0].status, 'error');
  assert.equal(lines[0].error, 'no_response');
});

test('shadow logs error when codex returns API error', async (t) => {
  const origKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'shadow-test-'));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
    if (origKey !== undefined) {
      process.env.OPENAI_API_KEY = origKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  const logPath = path.join(tempDir, 'shadow.jsonl');

  const evaluator = new ShadowEvaluator({
    config: { shadow: { enabled: true }, openai: {} },
    logPath,
    log: silentLog,
    now: () => 1000,
    fetchCodex: () => Promise.resolve({ error: { message: 'rate_limit_exceeded' } }),
  });

  const ctx = evaluator.maybeStart(makeClassification(), makeBody());
  ctx.complete();
  await new Promise(r => setTimeout(r, 50));

  const lines = (await readFile(logPath, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines[0].status, 'error');
  assert.equal(lines[0].error, 'rate_limit_exceeded');
});

test('shadow with no divergence logs min_similarity 1', async (t) => {
  const origKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'shadow-test-'));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
    if (origKey !== undefined) {
      process.env.OPENAI_API_KEY = origKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  const logPath = path.join(tempDir, 'shadow.jsonl');

  const evaluator = new ShadowEvaluator({
    config: { shadow: { enabled: true }, openai: { default_model: 'gpt-5.4' } },
    logPath,
    log: silentLog,
    now: () => 1000,
    fetchCodex: () => Promise.resolve({
      model: 'gpt-5.4',
      choices: [{ message: { content: null } }],
      usage: {},
    }),
  });

  const ctx = evaluator.maybeStart(makeClassification(), makeBody());
  ctx.complete();
  await new Promise(r => setTimeout(r, 50));

  const lines = (await readFile(logPath, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines[0].status, 'ok');
  assert.equal(lines[0].min_similarity, 1);
  assert.equal(lines[0].warning, false);
  assert.equal(lines[0].divergences.length, 0);
});

test('shadow integration: does not delay proxy response', async (t) => {
  const origKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'shadow-int-'));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
    if (origKey !== undefined) {
      process.env.OPENAI_API_KEY = origKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  const { startProxyServer } = await import('../src/proxy.mjs');
  const { MetricsLogger } = await import('../src/logger.mjs');

  const logPath = path.join(tempDir, 'metrics.jsonl');
  const shadowLogPath = path.join(tempDir, 'shadow.jsonl');
  const logger = new MetricsLogger({ logPath });

  let codexResolve;
  const codexPromise = new Promise(r => { codexResolve = r; });

  const shadow = createShadowEvaluator({
    config: {
      shadow: { enabled: true },
      openai: { default_model: 'gpt-5.4' },
    },
    logPath: shadowLogPath,
    log: silentLog,
    fetchCodex: () => codexPromise,
  });

  // Mock upstream (Anthropic)
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        'event: content_block_start\n' +
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"Read","input":{}}}\n\n',
      );
      res.end(
        'event: message_delta\n' +
        'data: {"type":"message_delta","usage":{"output_tokens":5}}\n\n',
      );
    });
  });

  await new Promise((resolve, reject) => {
    upstream.listen(0, '127.0.0.1', err => err ? reject(err) : resolve());
  });
  const upstreamPort = upstream.address().port;

  t.after(async () => {
    await new Promise((resolve, reject) => {
      upstream.close(err => err ? reject(err) : resolve());
    });
  });

  const proxy = await startProxyServer({
    port: 0,
    logger,
    shadow,
    config: {
      anthropic: { base_url: `http://127.0.0.1:${upstreamPort}` },
      shadow: { enabled: true },
      openai: { default_model: 'gpt-5.4' },
    },
    log: silentLog,
  });

  t.after(async () => { await proxy.shutdown('test'); });

  const body = JSON.stringify({
    model: 'claude-opus-4-6',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ name: 'Read' }, { name: 'Edit' }],
    metadata: { user_id: JSON.stringify({ querySource: 'agent:custom' }) },
  });

  // Send request through proxy
  const startTime = Date.now();
  const response = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxy.port,
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-client-request-id': 'req-shadow-test',
        'x-claude-code-session-id': 'session-shadow',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const elapsed = Date.now() - startTime;

  // Proxy response should have returned quickly, NOT waiting for codex
  assert.equal(response.statusCode, 200);
  assert.ok(elapsed < 5000, `proxy responded in ${elapsed}ms (should be <5000ms)`);

  // Now resolve the codex promise (simulate slow codex)
  codexResolve({
    model: 'gpt-5.4',
    choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Write', arguments: '{}' } }] } }],
    usage: { prompt_tokens: 50, completion_tokens: 10 },
  });

  // Wait for shadow to complete and log
  await new Promise(r => setTimeout(r, 100));

  const shadowLines = (await readFile(shadowLogPath, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.equal(shadowLines.length, 1);
  assert.equal(shadowLines[0].status, 'ok');
  assert.equal(shadowLines[0].session_id, 'session-shadow');
  assert.ok(shadowLines[0].divergences.length > 0);
});
