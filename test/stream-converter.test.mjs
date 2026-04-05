import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  OpenAIToAnthropicStream,
  convertOpenAIResponseToAnthropicSse,
  createStreamConverter,
} from '../src/stream-converter.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openaiSse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function openaiDone() {
  return 'data: [DONE]\n\n';
}

function collectOutput(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk.toString('utf8')));
    stream.on('end', () => resolve(chunks.join('')));
    stream.on('error', reject);
  });
}

function parseAnthropicEvents(raw) {
  const events = [];
  const parts = raw.split('\n\n').filter(Boolean);

  for (const part of parts) {
    let eventName = null;
    let data = null;

    for (const line of part.split('\n')) {
      if (line.startsWith('event: ')) {
        eventName = line.slice('event: '.length);
      } else if (line.startsWith('data: ')) {
        data = JSON.parse(line.slice('data: '.length));
      }
    }

    if (eventName && data) {
      events.push({ event: eventName, data });
    }
  }

  return events;
}

function feedChunks(converter, chunks) {
  const input = new PassThrough();
  input.pipe(converter);

  for (const chunk of chunks) {
    input.write(chunk);
  }

  input.end();
  return collectOutput(converter);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('emits correct event sequence for text-only stream', async () => {
  const converter = createStreamConverter({ model: 'gpt-5.4', inputTokens: 10 });

  const chunks = [
    openaiSse({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }),
    openaiSse({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: 'Hello' } }] }),
    openaiSse({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: ' world' } }] }),
    openaiSse({ id: 'chatcmpl-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }),
    openaiDone(),
  ];

  const raw = await feedChunks(converter, chunks);
  const events = parseAnthropicEvents(raw);
  const eventTypes = events.map(e => e.event);

  assert.equal(eventTypes[0], 'message_start');
  assert.equal(events[0].data.message.model, 'gpt-5.4');
  assert.equal(events[0].data.message.usage.input_tokens, 10);

  assert.equal(eventTypes[1], 'content_block_start');
  assert.equal(events[1].data.content_block.type, 'text');

  assert.equal(eventTypes[2], 'content_block_delta');
  assert.equal(events[2].data.delta.text, 'Hello');

  assert.equal(eventTypes[3], 'content_block_delta');
  assert.equal(events[3].data.delta.text, ' world');

  assert.equal(eventTypes[4], 'content_block_stop');
  assert.equal(eventTypes[5], 'message_delta');
  assert.equal(events[5].data.delta.stop_reason, 'end_turn');
  assert.equal(eventTypes[6], 'message_stop');
});

test('handles tool_calls streaming', async () => {
  const converter = createStreamConverter({ model: 'gpt-5.4' });

  const chunks = [
    // First delta: tool call start with id and name
    openaiSse({
      id: 'chatcmpl-tc',
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: 'call_abc',
            type: 'function',
            function: { name: 'Read', arguments: '' },
          }],
        },
      }],
    }),
    // Second delta: arguments chunk 1
    openaiSse({
      id: 'chatcmpl-tc',
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            function: { arguments: '{"file' },
          }],
        },
      }],
    }),
    // Third delta: arguments chunk 2
    openaiSse({
      id: 'chatcmpl-tc',
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            function: { arguments: '_path":"a.txt"}' },
          }],
        },
      }],
    }),
    // Finish
    openaiSse({
      id: 'chatcmpl-tc',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    }),
    openaiDone(),
  ];

  const raw = await feedChunks(converter, chunks);
  const events = parseAnthropicEvents(raw);
  const eventTypes = events.map(e => e.event);

  // message_start
  assert.equal(eventTypes[0], 'message_start');

  // content_block_start for tool_use
  const blockStart = events.find(e => e.event === 'content_block_start');
  assert.equal(blockStart.data.content_block.type, 'tool_use');
  assert.equal(blockStart.data.content_block.id, 'call_abc');
  assert.equal(blockStart.data.content_block.name, 'Read');

  // input_json_delta events
  const jsonDeltas = events.filter(e =>
    e.event === 'content_block_delta' && e.data.delta.type === 'input_json_delta',
  );
  assert.equal(jsonDeltas.length, 2);
  assert.equal(jsonDeltas[0].data.delta.partial_json, '{"file');
  assert.equal(jsonDeltas[1].data.delta.partial_json, '_path":"a.txt"}');

  // content_block_stop
  assert.ok(eventTypes.includes('content_block_stop'));

  // message_delta with tool_use stop_reason
  const msgDelta = events.find(e => e.event === 'message_delta');
  assert.equal(msgDelta.data.delta.stop_reason, 'tool_use');

  assert.ok(eventTypes.includes('message_stop'));
});

test('handles mixed text + tool_calls', async () => {
  const converter = createStreamConverter({ model: 'gpt-5.4' });

  const chunks = [
    // Text first
    openaiSse({ id: 'chatcmpl-m', choices: [{ index: 0, delta: { content: 'Reading file.' } }] }),
    // Then tool call
    openaiSse({
      id: 'chatcmpl-m',
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'Read', arguments: '{}' },
          }],
        },
      }],
    }),
    openaiSse({ id: 'chatcmpl-m', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    openaiDone(),
  ];

  const raw = await feedChunks(converter, chunks);
  const events = parseAnthropicEvents(raw);
  const eventTypes = events.map(e => e.event);

  // message_start, text block start, text delta, text block stop,
  // tool block start, tool delta, tool block stop, message_delta, message_stop
  assert.equal(eventTypes[0], 'message_start');

  // Text block
  assert.equal(events[1].event, 'content_block_start');
  assert.equal(events[1].data.content_block.type, 'text');
  assert.equal(events[2].event, 'content_block_delta');
  assert.equal(events[2].data.delta.text, 'Reading file.');
  // Text block gets closed when tool starts
  assert.equal(events[3].event, 'content_block_stop');

  // Tool block
  assert.equal(events[4].event, 'content_block_start');
  assert.equal(events[4].data.content_block.type, 'tool_use');
});

test('handles multiple tool calls', async () => {
  const converter = createStreamConverter({ model: 'gpt-5.4' });

  const chunks = [
    openaiSse({
      id: 'chatcmpl-mt',
      choices: [{
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: 'call_1', function: { name: 'Read', arguments: '{}' } },
          ],
        },
      }],
    }),
    openaiSse({
      id: 'chatcmpl-mt',
      choices: [{
        index: 0,
        delta: {
          tool_calls: [
            { index: 1, id: 'call_2', function: { name: 'Edit', arguments: '{}' } },
          ],
        },
      }],
    }),
    openaiSse({ id: 'chatcmpl-mt', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    openaiDone(),
  ];

  const raw = await feedChunks(converter, chunks);
  const events = parseAnthropicEvents(raw);

  const blockStarts = events.filter(e =>
    e.event === 'content_block_start' && e.data.content_block.type === 'tool_use',
  );
  assert.equal(blockStarts.length, 2);
  assert.equal(blockStarts[0].data.content_block.name, 'Read');
  assert.equal(blockStarts[1].data.content_block.name, 'Edit');
  assert.equal(blockStarts[0].data.index, 0);
  assert.equal(blockStarts[1].data.index, 1);
});

test('handles empty stream gracefully', async () => {
  const converter = createStreamConverter({ model: 'gpt-5.4' });

  const chunks = [openaiDone()];

  const raw = await feedChunks(converter, chunks);
  const events = parseAnthropicEvents(raw);
  const eventTypes = events.map(e => e.event);

  // Should still emit message_delta and message_stop
  assert.ok(eventTypes.includes('message_delta'));
  assert.ok(eventTypes.includes('message_stop'));
});

test('handles chunked SSE (split across write boundaries)', async () => {
  const converter = createStreamConverter({ model: 'gpt-5.4' });

  // Split a single SSE event across two write() calls
  const full = openaiSse({ id: 'chatcmpl-split', choices: [{ index: 0, delta: { content: 'split' } }] });
  const mid = Math.floor(full.length / 2);

  const chunks = [
    full.slice(0, mid),
    full.slice(mid),
    openaiSse({ id: 'chatcmpl-split', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    openaiDone(),
  ];

  const raw = await feedChunks(converter, chunks);
  const events = parseAnthropicEvents(raw);

  const textDeltas = events.filter(e =>
    e.event === 'content_block_delta' && e.data.delta.type === 'text_delta',
  );
  assert.equal(textDeltas.length, 1);
  assert.equal(textDeltas[0].data.delta.text, 'split');
});

test('createStreamConverter factory returns OpenAIToAnthropicStream', () => {
  const converter = createStreamConverter({ model: 'test' });
  assert.ok(converter instanceof OpenAIToAnthropicStream);
});

test('convertOpenAIResponseToAnthropicSse synthesizes Anthropic SSE from a non-streaming response', async () => {
  const raw = await convertOpenAIResponseToAnthropicSse({
    id: 'chatcmpl-sync',
    model: 'gpt-5.4',
    usage: { prompt_tokens: 14, completion_tokens: 6 },
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        content: 'Reading the file.',
        tool_calls: [{
          id: 'call_sync',
          type: 'function',
          function: {
            name: 'Read',
            arguments: '{"path":"/tmp/demo.txt"}',
          },
        }],
      },
    }],
  }, { model: 'gpt-5.4' });

  const events = parseAnthropicEvents(raw.toString('utf8'));
  assert.equal(events[0].event, 'message_start');
  assert.equal(events[1].event, 'content_block_start');
  assert.equal(events[2].data.delta.text, 'Reading the file.');

  const toolStart = events.find((event) =>
    event.event === 'content_block_start' && event.data.content_block.type === 'tool_use',
  );
  assert.ok(toolStart);
  assert.equal(toolStart.data.content_block.name, 'Read');

  const messageDelta = events.find((event) => event.event === 'message_delta');
  assert.equal(messageDelta.data.delta.stop_reason, 'tool_use');
  assert.equal(messageDelta.data.usage.output_tokens, 6);
});

test('maps finish_reason "length" to "max_tokens"', async () => {
  const converter = createStreamConverter({ model: 'gpt-5.4' });

  const chunks = [
    openaiSse({ id: 'chatcmpl-len', choices: [{ index: 0, delta: { content: 'trunc' } }] }),
    openaiSse({ id: 'chatcmpl-len', choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }),
    openaiDone(),
  ];

  const raw = await feedChunks(converter, chunks);
  const events = parseAnthropicEvents(raw);

  const msgDelta = events.find(e => e.event === 'message_delta');
  assert.equal(msgDelta.data.delta.stop_reason, 'max_tokens');
});
