import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import test from 'node:test';

import { MetricsLogger } from '../src/logger.mjs';
import { startProxyServer } from '../src/proxy.mjs';

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
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );

    req.on('error', reject);
    req.end(body);
  });
}

function silentLog() {
  return {
    info() {},
    error() {},
  };
}

test('proxy routes matching agent requests directly to openai', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'claude-gate-routing-'));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const logPath = path.join(tempDir, 'metrics.jsonl');
  const logger = new MetricsLogger({ logPath });

  let anthropicRequests = 0;
  const anthropic = http.createServer((req, res) => {
    anthropicRequests += 1;
    res.writeHead(500);
    res.end('should not be called');
  });
  const anthropicAddress = await listen(anthropic);
  t.after(async () => {
    await new Promise((resolve, reject) => {
      anthropic.close((error) => (error ? reject(error) : resolve()));
    });
  });

  let openaiCalled = false;
  const mockOpenAIRequestImpl = async ({ body }) => {
    openaiCalled = true;
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'chatcmpl_route',
        model: 'gpt-5.4',
        usage: { prompt_tokens: 18, completion_tokens: 7 },
        choices: [{ finish_reason: 'stop', message: { content: 'routed through openai' } }],
      }),
    };
  };

  const proxy = await startProxyServer({
    port: 0,
    logger,
    openAIRequestImpl: mockOpenAIRequestImpl,
    config: {
      anthropic: {
        base_url: `http://127.0.0.1:${anthropicAddress.port}`,
      },
      openai: {
        default_model: 'gpt-5.4',
      },
      routing: {
        enabled: true,
        rules: [
          {
            name: 'agent-worker-to-codex',
            enabled: true,
            target: 'openai',
            model: 'gpt-5.4',
            condition: {
              query_source: ['agent:default'],
              tool_count_max: 3,
              thinking_enabled: false,
            },
          },
        ],
      },
      shadow: {
        enabled: false,
      },
    },
    log: silentLog(),
  });

  t.after(async () => {
    await proxy.shutdown('test');
  });

  const response = await request({
    port: proxy.port,
    body: JSON.stringify({
      model: 'claude-opus-4-6',
      stream: false,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object' } }],
      metadata: { user_id: '{"querySource":"agent:default"}' },
    }),
    headers: {
      'x-client-request-id': 'req-route-1',
      'x-claude-code-session-id': 'session-route',
    },
  });

  await logger.close();

  assert.equal(anthropicRequests, 0);
  assert.equal(openaiCalled, true);
  assert.equal(response.statusCode, 200);

  const responseBody = JSON.parse(response.body.toString('utf8'));
  assert.equal(responseBody.role, 'assistant');
  assert.equal(responseBody.content[0].text, 'routed through openai');
  assert.equal(responseBody.usage.input_tokens, 18);
  assert.equal(responseBody.stop_reason, 'end_turn');

  const logLines = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(logLines.at(-1).routed_to, 'openai');
});

test('proxy falls back to openai on anthropic 529 before streaming starts', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'claude-gate-fallback-'));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const logPath = path.join(tempDir, 'metrics.jsonl');
  const logger = new MetricsLogger({ logPath });

  let anthropicBody = null;
  const anthropic = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      anthropicBody = Buffer.concat(chunks).toString('utf8');
      res.writeHead(529, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'overloaded' }));
    });
  });
  const anthropicAddress = await listen(anthropic);
  t.after(async () => {
    await new Promise((resolve, reject) => {
      anthropic.close((error) => (error ? reject(error) : resolve()));
    });
  });

  let openaiCalls = 0;
  const mockOpenAIRequestImpl = async () => {
    openaiCalls += 1;
    const body = JSON.stringify({
      id: 'chatcmpl_fallback',
      model: 'gpt-5.4',
      usage: {
        prompt_tokens: 11,
        completion_tokens: 5,
      },
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: 'fallback response',
          },
        },
      ],
    });
    return { statusCode: 200, headers: { 'content-type': 'application/json' }, body };
  };

  const proxy = await startProxyServer({
    port: 0,
    logger,
    openAIRequestImpl: mockOpenAIRequestImpl,
    config: {
      anthropic: {
        base_url: `http://127.0.0.1:${anthropicAddress.port}`,
      },
      openai: {
        default_model: 'gpt-5.4',
      },
      routing: {
        enabled: false,
        rules: [],
      },
      fallback_529: {
        enabled: true,
        target_query_sources: ['agent:custom', 'agent:default'],
      },
      shadow: {
        enabled: false,
      },
    },
    log: silentLog(),
  });

  t.after(async () => {
    await proxy.shutdown('test');
  });

  const originalBody = JSON.stringify({
    model: 'claude-opus-4-6',
    stream: false,
    messages: [{ role: 'user', content: 'hello' }],
    metadata: { user_id: '{"querySource":"agent:custom"}' },
  });

  const response = await request({
    port: proxy.port,
    body: originalBody,
    headers: {
      'x-client-request-id': 'req-fallback-1',
      'x-claude-code-session-id': 'session-fallback',
    },
  });

  await logger.close();

  assert.equal(anthropicBody, originalBody);
  assert.equal(openaiCalls, 1);
  assert.equal(response.statusCode, 200);

  const responseBody = JSON.parse(response.body.toString('utf8'));
  assert.equal(responseBody.content[0].text, 'fallback response');

  const logLines = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(logLines.at(-1).routed_to, 'openai_fallback');
});

test('proxy does not fallback on anthropic 529 for non-agent requests', async (t) => {

  const anthropic = http.createServer((req, res) => {
    res.writeHead(529, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'overloaded' }));
  });
  const anthropicAddress = await listen(anthropic);
  t.after(async () => {
    await new Promise((resolve, reject) => {
      anthropic.close((error) => (error ? reject(error) : resolve()));
    });

  });

  let openaiCalls = 0;
  const mockOpenAIRequestImpl = async () => {
    openaiCalls += 1;
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ choices: [{ message: { content: 'unexpected' } }] }),
    };
  };

  const proxy = await startProxyServer({
    port: 0,
    openAIRequestImpl: mockOpenAIRequestImpl,
    config: {
      anthropic: {
        base_url: `http://127.0.0.1:${anthropicAddress.port}`,
      },
      openai: {
        default_model: 'gpt-5.4',
      },
      fallback_529: {
        enabled: true,
        target_query_sources: ['agent:custom', 'agent:default'],
      },
      shadow: {
        enabled: false,
      },
    },
    log: silentLog(),
  });

  t.after(async () => {
    await proxy.shutdown('test');
  });

  const response = await request({
    port: proxy.port,
    body: JSON.stringify({
      model: 'claude-opus-4-6',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }],
      metadata: { user_id: '{"querySource":"repl_main_thread"}' },
    }),
    headers: {
      'x-client-request-id': 'req-fallback-2',
      'x-claude-code-session-id': 'session-no-fallback',
    },
  });

  assert.equal(openaiCalls, 0);
  assert.equal(response.statusCode, 529);
  assert.deepEqual(JSON.parse(response.body.toString('utf8')), { error: 'overloaded' });
});
