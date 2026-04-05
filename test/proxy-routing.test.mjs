import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import test from 'node:test';

import { createRequestClassifier } from '../src/classifier.mjs';
import { MetricsLogger } from '../src/logger.mjs';
import { proxyRequest } from '../src/proxy.mjs';
import { createShadowEvaluator } from '../src/shadow.mjs';
import { createMockRequest, MockResponse, parseSseEvents } from './proxy-test-helpers.mjs';

function silentLog() {
  return {
    info() {},
    error() {},
  };
}

async function runProxyRequest({
  body,
  config,
  logger,
  anthropicExecutor = null,
  openAIRequestImpl = null,
  codexFn = null,
}) {
  const classifier = createRequestClassifier();
  const shadow = createShadowEvaluator({ config, log: silentLog() });
  const { req, send } = createMockRequest({
    body,
    headers: {
      'x-client-request-id': 'req-test',
      'x-claude-code-session-id': 'session-test',
    },
  });
  const res = new MockResponse();

  const requestPromise = proxyRequest({
    req,
    res,
    config,
    logger,
    classifier,
    log: silentLog(),
    shadow,
    anthropicExecutor,
    openAIRequestImpl,
    codexFn,
  });

  send();
  await requestPromise;
  return res;
}

test('proxy routes matching agent requests directly to openai', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'claude-gate-routing-'));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const logPath = path.join(tempDir, 'metrics.jsonl');
  const logger = new MetricsLogger({ logPath });
  t.after(async () => {
    await logger.close();
  });

  let openaiCalled = false;
  const response = await runProxyRequest({
    logger,
    body: {
      model: 'claude-opus-4-6',
      stream: false,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object' } }],
      metadata: { user_id: '{"querySource":"agent:default"}' },
    },
    openAIRequestImpl: async ({ body: requestBody }) => {
      openaiCalled = true;
      const parsed = JSON.parse(requestBody);
      assert.equal(parsed.messages.at(-1).role, 'user');
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
    },
    config: {
      anthropic: {
        base_url: 'http://anthropic.invalid',
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
  });

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

test('proxy emits Anthropic SSE when a streaming route is handled by codex', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'claude-gate-stream-route-'));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const logPath = path.join(tempDir, 'metrics.jsonl');
  const logger = new MetricsLogger({ logPath });
  t.after(async () => {
    await logger.close();
  });

  const response = await runProxyRequest({
    logger,
    body: {
      model: 'claude-opus-4-6',
      stream: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object' } }],
      metadata: { user_id: '{"querySource":"agent:default"}' },
    },
    codexFn: async () => ({
      id: 'chatcmpl_stream_route',
      model: 'gpt-5.4',
      usage: { prompt_tokens: 9, completion_tokens: 4 },
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          content: 'Reading the file.',
          tool_calls: [{
            id: 'call_route',
            type: 'function',
            function: {
              name: 'Read',
              arguments: '{"path":"/tmp/demo.txt"}',
            },
          }],
        },
      }],
    }),
    config: {
      anthropic: {
        base_url: 'http://anthropic.invalid',
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
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'text/event-stream');

  const events = parseSseEvents(response.body.toString('utf8'));
  assert.deepEqual(events.map((event) => event.event), [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);
  assert.equal(events[2].data.delta.text, 'Reading the file.');
  assert.equal(events[4].data.content_block.type, 'tool_use');
  assert.equal(events[4].data.content_block.name, 'Read');
  assert.equal(events[7].data.delta.stop_reason, 'tool_use');

  const logLines = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(logLines.at(-1).routed_to, 'openai');
  assert.equal(logLines.at(-1).status, 200);
});

test('proxy falls back to openai on anthropic 529 before streaming starts', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'claude-gate-fallback-'));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const logPath = path.join(tempDir, 'metrics.jsonl');
  const logger = new MetricsLogger({ logPath });
  t.after(async () => {
    await logger.close();
  });

  let anthropicBody = null;
  let openaiCalls = 0;
  const originalBody = {
    model: 'claude-opus-4-6',
    stream: false,
    messages: [{ role: 'user', content: 'hello' }],
    metadata: { user_id: '{"querySource":"agent:custom"}' },
  };

  const response = await runProxyRequest({
    logger,
    body: originalBody,
    anthropicExecutor: async ({ bodyBuffer }) => {
      anthropicBody = bodyBuffer.toString('utf8');
      return {
        statusCode: 529,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'overloaded' }),
      };
    },
    openAIRequestImpl: async () => {
      openaiCalls += 1;
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'chatcmpl_fallback',
          model: 'gpt-5.4',
          usage: { prompt_tokens: 11, completion_tokens: 5 },
          choices: [{ finish_reason: 'stop', message: { content: 'fallback response' } }],
        }),
      };
    },
    config: {
      anthropic: {
        base_url: 'http://anthropic.invalid',
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
  });

  assert.equal(anthropicBody, JSON.stringify(originalBody));
  assert.equal(openaiCalls, 1);
  assert.equal(response.statusCode, 200);

  const responseBody = JSON.parse(response.body.toString('utf8'));
  assert.equal(responseBody.content[0].text, 'fallback response');

  const logLines = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(logLines.at(-1).routed_to, 'openai_fallback');
});

test('proxy does not fallback on anthropic 529 for non-agent requests', async () => {
  const logger = new MetricsLogger({ logPath: path.join(os.tmpdir(), `cc-mux-${Date.now()}.jsonl`) });
  let openaiCalls = 0;
  const response = await runProxyRequest({
    logger,
    body: {
      model: 'claude-opus-4-6',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }],
      metadata: { user_id: '{"querySource":"repl_main_thread"}' },
    },
    anthropicExecutor: async () => ({
      statusCode: 529,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'overloaded' }),
    }),
    openAIRequestImpl: async () => {
      openaiCalls += 1;
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ choices: [{ message: { content: 'unexpected' } }] }),
      };
    },
    config: {
      anthropic: {
        base_url: 'http://anthropic.invalid',
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
  });
  await logger.close();

  assert.equal(openaiCalls, 0);
  assert.equal(response.statusCode, 529);
  assert.deepEqual(JSON.parse(response.body.toString('utf8')), { error: 'overloaded' });
});
