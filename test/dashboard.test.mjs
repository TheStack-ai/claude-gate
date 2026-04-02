import assert from 'node:assert/strict';
import test from 'node:test';

import { translateQuerySource, translateRoutedTo, progressBar, createSessionState, ingestRecord } from '../src/dashboard.mjs';

test('translateQuerySource returns the short model name', () => {
  assert.equal(translateQuerySource('claude-opus-4-6', 0), 'opus-4-6');
  assert.equal(translateQuerySource('claude-sonnet-4-5', 0), 'sonnet-4-5');
  assert.equal(translateQuerySource('claude-haiku-3-5', 0, 'ko'), 'haiku-3-5');
  assert.equal(translateQuerySource(null, 0), 'unknown');
});

test('translateRoutedTo returns an empty string for compatibility', () => {
  assert.equal(translateRoutedTo('anthropic'), '');
  assert.equal(translateRoutedTo('openai'), '');
  assert.equal(translateRoutedTo('openai_fallback', 'ko'), '');
  assert.equal(translateRoutedTo(null), '');
});

test('progressBar renders correct fill ratio', () => {
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  assert.equal(strip(progressBar(0, 10)), '░░░░░░░░░░');
  assert.equal(strip(progressBar(1, 10)), '██████████');
  assert.equal(strip(progressBar(0.5, 10)), '█████░░░░░');
});

test('ingestRecord skips non-API calls (404, no model)', () => {
  const state = createSessionState();

  ingestRecord(state, {
    ts: '2026-04-02T10:00:00Z',
    model: null,
    input_tokens: 0,
    output_tokens: 0,
    status: 404,
  });

  assert.equal(state.apiCalls, 0);
  assert.equal(state.recentEvents.length, 0);

  ingestRecord(state, {
    ts: '2026-04-02T10:00:01Z',
    model: 'claude-opus-4-6',
    input_tokens: 1000,
    output_tokens: 200,
    duration_ms: 1200,
    status: 200,
    routed_to: 'anthropic',
  });

  assert.equal(state.apiCalls, 1);
  assert.equal(state.claudeCount, 1);
  assert.equal(state.codexCount, 0);
});

test('ingestRecord tracks Claude vs Codex routing', () => {
  const state = createSessionState();

  ingestRecord(state, {
    ts: '2026-04-02T10:00:00Z',
    model: 'claude-opus-4-6',
    input_tokens: 50000,
    output_tokens: 1000,
    duration_ms: 2500,
    status: 200,
    routed_to: 'anthropic',
  });

  ingestRecord(state, {
    ts: '2026-04-02T10:00:05Z',
    model: 'gpt-5.4',
    input_tokens: 50000,
    output_tokens: 800,
    duration_ms: 1800,
    status: 200,
    routed_to: 'openai',
  });

  assert.equal(state.apiCalls, 2);
  assert.equal(state.claudeCount, 1);
  assert.equal(state.codexCount, 1);
  assert.equal(state.codexInputTokens, 50000);
  assert.equal(state.codexOutputTokens, 800);
  assert.ok(state.codexSavings > 0);
});

test('ingestRecord tracks 529 fallback count', () => {
  const state = createSessionState();

  ingestRecord(state, {
    ts: '2026-04-02T10:00:00Z',
    model: 'claude-opus-4-6',
    input_tokens: 0,
    output_tokens: 0,
    duration_ms: 100,
    status: 529,
    routed_to: 'anthropic',
  });

  assert.equal(state.apiCalls, 1);
  assert.equal(state.claudeCount, 1);
  assert.equal(state.fallback529Count, 1);
});

test('recentEvents caps at 8 entries', () => {
  const state = createSessionState();
  for (let i = 0; i < 15; i++) {
    ingestRecord(state, {
      ts: `2026-04-02T10:${String(i).padStart(2, '0')}:00Z`,
      model: 'claude-opus-4-6',
      input_tokens: 100,
      output_tokens: 10,
      duration_ms: 250,
      status: 200,
    });
  }
  assert.equal(state.recentEvents.length, 8);
  assert.equal(state.apiCalls, 15);
});

test('createSessionState initializes with correct defaults', () => {
  const state = createSessionState({ lang: 'ko' });

  assert.equal(state.lang, 'ko');
  assert.equal(state.apiCalls, 0);
  assert.equal(state.claudeCount, 0);
  assert.equal(state.codexCount, 0);
  assert.equal(state.codexSavings, 0);
  assert.equal(state.fallback529Count, 0);
});
