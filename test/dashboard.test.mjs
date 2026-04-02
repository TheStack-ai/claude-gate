import assert from 'node:assert/strict';
import test from 'node:test';

import { translateQuerySource, translateRoutedTo, progressBar, createSessionState, ingestRecord } from '../src/dashboard.mjs';

test('translateQuerySource maps known sources to Korean labels', () => {
  assert.equal(translateQuerySource('repl_main_thread', 0), '대표님 직접 대화');
  assert.equal(translateQuerySource('compact', 0), '맥락 압축');
  assert.equal(translateQuerySource('verification_agent', 0), '검증 작업');
  assert.equal(translateQuerySource('agent:custom', 3), 'AI 보조작업 (#3)');
  assert.equal(translateQuerySource('agent:default', 7), 'AI 보조작업 (#7)');
  assert.equal(translateQuerySource(null, 0), '알 수 없음');
});

test('translateRoutedTo maps routing targets to Korean', () => {
  assert.equal(translateRoutedTo('anthropic'), 'Claude');
  assert.equal(translateRoutedTo('openai'), 'Codex');
  assert.equal(translateRoutedTo('openai_fallback'), 'Codex');
  assert.equal(translateRoutedTo(null), '?');
});

test('progressBar renders correct fill ratio', () => {
  assert.equal(progressBar(0, 10), '░░░░░░░░░░');
  assert.equal(progressBar(1, 10), '██████████');
  assert.equal(progressBar(0.5, 10), '█████░░░░░');
});

test('ingestRecord accumulates session state correctly', () => {
  const state = createSessionState();

  ingestRecord(state, {
    ts: '2026-04-02T10:00:00Z',
    query_source: 'repl_main_thread',
    routed_to: 'anthropic',
    input_tokens: 1000,
    output_tokens: 200,
    cache_hit_rate: 0.8,
    status: 200,
  });

  assert.equal(state.turns, 1);
  assert.equal(state.directCount, 1);
  assert.equal(state.agentCount, 0);
  assert.equal(state.totalInputTokens, 1000);

  ingestRecord(state, {
    ts: '2026-04-02T10:01:00Z',
    query_source: 'agent:custom',
    routed_to: 'openai',
    input_tokens: 500,
    output_tokens: 100,
    cache_hit_rate: 0.6,
    status: 200,
  });

  assert.equal(state.turns, 2);
  assert.equal(state.agentCount, 1);
  assert.equal(state.codexRoutedCount, 1);
  assert.equal(state.codexSavedTokens, 600);
  assert.equal(state.agentSeq, 1);

  ingestRecord(state, {
    ts: '2026-04-02T10:02:00Z',
    query_source: 'agent:default',
    routed_to: 'openai_fallback',
    input_tokens: 800,
    output_tokens: 150,
    cache_hit_rate: 0.5,
    status: 200,
  });

  assert.equal(state.turns, 3);
  assert.equal(state.fallbackCount, 1);
  assert.equal(state.codexSavedTokens, 1550);
  assert.equal(state.recentEvents.length, 3);
});

test('recentEvents caps at 10 entries', () => {
  const state = createSessionState();
  for (let i = 0; i < 15; i++) {
    ingestRecord(state, {
      ts: `2026-04-02T10:${String(i).padStart(2, '0')}:00Z`,
      query_source: 'repl_main_thread',
      routed_to: 'anthropic',
      input_tokens: 100,
      output_tokens: 10,
      status: 200,
    });
  }
  assert.equal(state.recentEvents.length, 10);
  assert.equal(state.turns, 15);
});
