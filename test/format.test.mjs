import assert from 'node:assert/strict';
import test from 'node:test';

import { convertAnthropicToOpenAI } from '../src/format.mjs';

test('converts simple text messages', () => {
  const result = convertAnthropicToOpenAI({
    model: 'claude-opus-4-6',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ],
  });

  assert.equal(result.model, 'gpt-5.4');
  assert.equal(result.messages.length, 2);
  assert.deepEqual(result.messages[0], { role: 'user', content: 'hello' });
  assert.deepEqual(result.messages[1], { role: 'assistant', content: 'hi there' });
});

test('converts text content block arrays to strings', () => {
  const result = convertAnthropicToOpenAI({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello world' }] },
    ],
  });

  assert.equal(result.messages[0].content, 'hello world');
});

test('converts system prompt to first system message', () => {
  const result = convertAnthropicToOpenAI({
    system: 'You are helpful.',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(result.messages.length, 2);
  assert.deepEqual(result.messages[0], { role: 'system', content: 'You are helpful.' });
  assert.deepEqual(result.messages[1], { role: 'user', content: 'hi' });
});

test('converts array system prompt', () => {
  const result = convertAnthropicToOpenAI({
    system: [
      { type: 'text', text: 'Part one.' },
      { type: 'text', text: 'Part two.' },
    ],
    messages: [],
  });

  assert.equal(result.messages[0].content, 'Part one.\nPart two.');
});

test('converts assistant tool_use to tool_calls', () => {
  const result = convertAnthropicToOpenAI({
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me read that.' },
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/foo' } },
        ],
      },
    ],
  });

  const msg = result.messages[0];
  assert.equal(msg.role, 'assistant');
  assert.equal(msg.content, 'Let me read that.');
  assert.equal(msg.tool_calls.length, 1);
  assert.equal(msg.tool_calls[0].id, 'tu_1');
  assert.equal(msg.tool_calls[0].type, 'function');
  assert.equal(msg.tool_calls[0].function.name, 'Read');
  assert.equal(msg.tool_calls[0].function.arguments, '{"path":"/foo"}');
});

test('assistant with only tool_use has null content', () => {
  const result = convertAnthropicToOpenAI({
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'Edit', input: {} },
        ],
      },
    ],
  });

  assert.equal(result.messages[0].content, null);
  assert.equal(result.messages[0].tool_calls.length, 1);
});

test('converts user tool_result to tool role messages', () => {
  const result = convertAnthropicToOpenAI({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'file contents here' },
        ],
      },
    ],
  });

  assert.equal(result.messages.length, 1);
  assert.deepEqual(result.messages[0], {
    role: 'tool',
    tool_call_id: 'tu_1',
    content: 'file contents here',
  });
});

test('converts tool_result with array content', () => {
  const result = convertAnthropicToOpenAI({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }],
          },
        ],
      },
    ],
  });

  assert.equal(result.messages[0].content, 'line1\nline2');
});

test('converts tools with input_schema to function parameters', () => {
  const result = convertAnthropicToOpenAI({
    messages: [],
    tools: [
      {
        name: 'Read',
        description: 'Read a file',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    ],
  });

  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].type, 'function');
  assert.equal(result.tools[0].function.name, 'Read');
  assert.equal(result.tools[0].function.description, 'Read a file');
  assert.deepEqual(result.tools[0].function.parameters, {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  });
});

test('strips Anthropic-only fields', () => {
  const result = convertAnthropicToOpenAI({
    model: 'claude-opus-4-6',
    messages: [{ role: 'user', content: 'hi' }],
    metadata: { user_id: '{"querySource":"agent:custom"}' },
    thinking: { type: 'disabled' },
    speed: 'fast',
    stream: true,
    top_k: 5,
    stop_sequences: ['END'],
  });

  assert.equal(result.metadata, undefined);
  assert.equal(result.thinking, undefined);
  assert.equal(result.speed, undefined);
  assert.equal(result.stream, undefined);
  assert.equal(result.top_k, undefined);
  assert.equal(result.stop_sequences, undefined);
});

test('carries over max_tokens, temperature, top_p', () => {
  const result = convertAnthropicToOpenAI({
    messages: [],
    max_tokens: 1024,
    temperature: 0.7,
    top_p: 0.9,
  });

  assert.equal(result.max_tokens, 1024);
  assert.equal(result.temperature, 0.7);
  assert.equal(result.top_p, 0.9);
});

test('uses custom model from config', () => {
  const result = convertAnthropicToOpenAI(
    { messages: [] },
    { default_model: 'gpt-4o' },
  );

  assert.equal(result.model, 'gpt-4o');
});

test('skips thinking blocks in assistant content', () => {
  const result = convertAnthropicToOpenAI({
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me think...' },
          { type: 'text', text: 'Here is my answer.' },
        ],
      },
    ],
  });

  assert.equal(result.messages[0].content, 'Here is my answer.');
  assert.equal(result.messages[0].tool_calls, undefined);
});

test('full conversation round-trip', () => {
  const result = convertAnthropicToOpenAI({
    model: 'claude-opus-4-6',
    system: 'You are a coding assistant.',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Read /foo.js' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: "I'll read that file." },
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/foo.js' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'console.log("hello")' },
        ],
      },
    ],
    tools: [
      { name: 'Read', description: 'Read a file', input_schema: { type: 'object' } },
    ],
    max_tokens: 4096,
    metadata: { user_id: '{}' },
    thinking: { type: 'disabled' },
  }, { default_model: 'gpt-5.4' });

  assert.equal(result.model, 'gpt-5.4');
  assert.equal(result.messages.length, 4); // system + user + assistant + tool
  assert.equal(result.messages[0].role, 'system');
  assert.equal(result.messages[1].role, 'user');
  assert.equal(result.messages[1].content, 'Read /foo.js');
  assert.equal(result.messages[2].role, 'assistant');
  assert.equal(result.messages[2].tool_calls[0].function.name, 'Read');
  assert.equal(result.messages[3].role, 'tool');
  assert.equal(result.messages[3].content, 'console.log("hello")');
  assert.equal(result.tools.length, 1);
  assert.equal(result.max_tokens, 4096);
  assert.equal(result.metadata, undefined);
});
