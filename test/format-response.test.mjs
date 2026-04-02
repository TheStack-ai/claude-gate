import assert from 'node:assert/strict';
import test from 'node:test';

import { formatResponse } from '../src/format-response.mjs';

test('converts text-only response', () => {
  const openai = {
    id: 'chatcmpl-abc',
    model: 'gpt-5.4',
    choices: [{
      message: { role: 'assistant', content: 'Hello world' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };

  const result = formatResponse(openai);

  assert.equal(result.id, 'chatcmpl-abc');
  assert.equal(result.type, 'message');
  assert.equal(result.role, 'assistant');
  assert.equal(result.model, 'gpt-5.4');
  assert.equal(result.stop_reason, 'end_turn');
  assert.equal(result.stop_sequence, null);
  assert.deepEqual(result.content, [{ type: 'text', text: 'Hello world' }]);
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 5 });
});

test('converts tool_calls response', () => {
  const openai = {
    id: 'chatcmpl-tool',
    model: 'gpt-5.4',
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_abc',
            type: 'function',
            function: {
              name: 'Read',
              arguments: '{"file_path":"/tmp/test.txt"}',
            },
          },
        ],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 20, completion_tokens: 15 },
  };

  const result = formatResponse(openai);

  assert.equal(result.stop_reason, 'tool_use');
  assert.equal(result.content.length, 1);
  assert.deepEqual(result.content[0], {
    type: 'tool_use',
    id: 'call_abc',
    name: 'Read',
    input: { file_path: '/tmp/test.txt' },
  });
  assert.deepEqual(result.usage, { input_tokens: 20, output_tokens: 15 });
});

test('converts mixed text + tool_calls', () => {
  const openai = {
    id: 'chatcmpl-mixed',
    model: 'gpt-5.4',
    choices: [{
      message: {
        role: 'assistant',
        content: 'Let me read that file.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'Read', arguments: '{"file_path":"a.txt"}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 5, completion_tokens: 10 },
  };

  const result = formatResponse(openai);

  assert.equal(result.content.length, 2);
  assert.equal(result.content[0].type, 'text');
  assert.equal(result.content[0].text, 'Let me read that file.');
  assert.equal(result.content[1].type, 'tool_use');
  assert.equal(result.content[1].name, 'Read');
});

test('model override takes precedence', () => {
  const openai = {
    id: 'chatcmpl-1',
    model: 'gpt-5.4',
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };

  const result = formatResponse(openai, { model: 'custom-model' });
  assert.equal(result.model, 'custom-model');
});

test('handles empty/null response gracefully', () => {
  const result = formatResponse(null);

  assert.equal(result.type, 'message');
  assert.equal(result.role, 'assistant');
  assert.equal(result.stop_reason, 'end_turn');
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
});

test('handles empty choices', () => {
  const result = formatResponse({ choices: [] });

  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.equal(result.content[0].text, '');
  assert.equal(result.stop_reason, 'end_turn');
});

test('maps finish_reason "length" to "max_tokens"', () => {
  const openai = {
    choices: [{ message: { content: 'truncated' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 1, completion_tokens: 100 },
  };

  const result = formatResponse(openai);
  assert.equal(result.stop_reason, 'max_tokens');
});

test('handles malformed tool arguments', () => {
  const openai = {
    choices: [{
      message: {
        tool_calls: [{
          id: 'call_bad',
          function: { name: 'Bash', arguments: '{invalid json' },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };

  const result = formatResponse(openai);
  assert.equal(result.content[0].type, 'tool_use');
  assert.deepEqual(result.content[0].input, {});
});

test('handles missing usage gracefully', () => {
  const openai = {
    choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
  };

  const result = formatResponse(openai);
  assert.deepEqual(result.usage, { input_tokens: 0, output_tokens: 0 });
});

test('handles multiple tool_calls', () => {
  const openai = {
    choices: [{
      message: {
        content: '',
        tool_calls: [
          { id: 'call_1', function: { name: 'Read', arguments: '{"file_path":"a.txt"}' } },
          { id: 'call_2', function: { name: 'Edit', arguments: '{"file_path":"b.txt"}' } },
        ],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  };

  const result = formatResponse(openai);

  // Empty string content is not included
  const toolBlocks = result.content.filter(b => b.type === 'tool_use');
  assert.equal(toolBlocks.length, 2);
  assert.equal(toolBlocks[0].name, 'Read');
  assert.equal(toolBlocks[1].name, 'Edit');
});
