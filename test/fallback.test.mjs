import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  convertOpenAIToAnthropicResponse,
  requestOpenAIChatCompletion,
  shouldHandle529Fallback,
} from '../src/fallback.mjs';

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

test('shouldHandle529Fallback only allows configured agent requests before bytes are sent', () => {
  const config = {
    fallback_529: {
      enabled: true,
      target_query_sources: ['agent:custom', 'agent:default'],
    },
  };

  assert.equal(
    shouldHandle529Fallback({
      config,
      classification: { querySource: 'agent:custom' },
      responseBytes: 0,
      anthropicBody: { stream: false },
    }),
    true,
  );

  assert.equal(
    shouldHandle529Fallback({
      config,
      classification: { querySource: 'repl_main_thread' },
      responseBytes: 0,
      anthropicBody: { stream: false },
    }),
    false,
  );

  assert.equal(
    shouldHandle529Fallback({
      config,
      classification: { querySource: 'agent:custom' },
      responseBytes: 1,
      anthropicBody: { stream: false },
    }),
    false,
  );

  assert.equal(
    shouldHandle529Fallback({
      config,
      classification: { querySource: 'agent:custom' },
      responseBytes: 0,
      anthropicBody: { stream: true },
    }),
    false,
  );
});

test('convertOpenAIToAnthropicResponse maps text, tool calls, usage, and stop reason', () => {
  const result = convertOpenAIToAnthropicResponse({
    id: 'chatcmpl_123',
    model: 'gpt-5.4',
    usage: {
      prompt_tokens: 21,
      completion_tokens: 9,
    },
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          content: 'I will read the file.',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'Read',
                arguments: '{"path":"/tmp/demo.txt"}',
              },
            },
          ],
        },
      },
    ],
  });

  assert.equal(result.id, 'chatcmpl_123');
  assert.equal(result.role, 'assistant');
  assert.equal(result.model, 'gpt-5.4');
  assert.equal(result.stop_reason, 'tool_use');
  assert.deepEqual(result.usage, {
    input_tokens: 21,
    output_tokens: 9,
  });
  assert.deepEqual(result.content, [
    { type: 'text', text: 'I will read the file.' },
    { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: '/tmp/demo.txt' } },
  ]);
});

test('requestOpenAIChatCompletion converts anthropic body from a copy and sends chat completions request', async () => {
  let receivedBody = null;
  const mockRequestImpl = async ({ body }) => {
    receivedBody = body;
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'chatcmpl_ok',
        model: 'gpt-5.4',
        usage: { prompt_tokens: 10, completion_tokens: 4 },
        choices: [{ finish_reason: 'stop', message: { content: 'done' } }],
      }),
    };
  };

  const bodyText = JSON.stringify({
    model: 'claude-opus-4-6',
    stream: false,
    system: 'You are helpful.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object' } }],
    metadata: { user_id: '{"querySource":"agent:custom"}' },
  });
  const bodyBuffer = Buffer.from(bodyText);
  const originalBuffer = Buffer.from(bodyBuffer);

  const response = await requestOpenAIChatCompletion({
    bodyBuffer,
    model: 'gpt-5.4',
    requestImpl: mockRequestImpl,
    config: {
      openai: {
        default_model: 'gpt-4.1',
      },
    },
  });

  assert.deepEqual(bodyBuffer, originalBuffer);

  const openaiBody = JSON.parse(receivedBody);
  assert.equal(openaiBody.model, 'gpt-5.4');
  assert.equal(openaiBody.stream, undefined);
  assert.equal(openaiBody.messages[0].role, 'system');
  assert.equal(openaiBody.messages[1].role, 'user');
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.choices[0].message.content, 'done');
});
