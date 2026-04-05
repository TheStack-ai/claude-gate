import assert from 'node:assert/strict';
import test from 'node:test';

import { createShadowEvaluator } from '../src/shadow.mjs';
import { makeBody, makeClassification, silentLog } from './shadow-test-helpers.mjs';

test('isEnabled returns false when shadow.enabled is false', () => {
  const evaluator = createShadowEvaluator({
    config: { shadow: { enabled: false }, openai: {} },
  });
  assert.equal(evaluator.isEnabled(), false);
});

test('isEnabled returns true when shadow.enabled is true (uses Codex CLI, no API key needed)', () => {
  const evaluator = createShadowEvaluator({
    config: { shadow: { enabled: true }, openai: {} },
  });
  assert.equal(evaluator.isEnabled(), true);
});

test('maybeStart returns null when not eligible', () => {
  const evaluator = createShadowEvaluator({
    config: { shadow: { enabled: true }, openai: {} },
    log: silentLog,
  });

  const ctx = evaluator.maybeStart(
    makeClassification({ shadowEligible: false }),
    makeBody(),
  );
  assert.equal(ctx, null);
});

test('maybeStart returns context when eligible', () => {
  const evaluator = createShadowEvaluator({
    config: { shadow: { enabled: true }, openai: {} },
    log: silentLog,
    fetchCodex: () => Promise.resolve(null),
  });

  const ctx = evaluator.maybeStart(makeClassification(), makeBody());
  assert.notEqual(ctx, null);
  assert.equal(typeof ctx.observeChunk, 'function');
  assert.equal(typeof ctx.complete, 'function');
});
