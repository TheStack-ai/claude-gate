import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequestClassifier } from '../src/classifier.mjs';

test('classifier treats mixed tool_result and user text as a normal user turn', () => {
  const classifier = createRequestClassifier();
  const result = classifier.classify({
    bodyBuffer: Buffer.from(JSON.stringify({
      model: 'claude-opus-4-6',
      tools: [{ name: 'Read' }],
      metadata: {
        user_id: JSON.stringify({ querySource: 'agent:default' }),
      },
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'file contents' }] },
          { type: 'text', text: 'and also explain it' },
        ],
      }],
    })),
  });

  assert.equal(result.lastMessageIsToolResult, false);
  assert.equal(result.shadowEligible, false);
});

test('classifier keeps pure tool_result last messages eligible', () => {
  const classifier = createRequestClassifier();
  const result = classifier.classify({
    bodyBuffer: Buffer.from(JSON.stringify({
      model: 'claude-opus-4-6',
      tools: [{ name: 'Read' }],
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'file contents' }] },
        ],
      }],
    })),
  });

  assert.equal(result.lastMessageIsToolResult, true);
  assert.equal(result.shadowEligible, true);
});
