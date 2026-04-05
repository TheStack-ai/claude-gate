import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { ShadowEvaluator } from '../src/shadow.mjs';
import { makeBody, makeClassification, makeTempDir, silentLog } from './shadow-test-helpers.mjs';

test('shadow with no divergence logs min_similarity 1', async (t) => {
  const tempDir = await makeTempDir(t);
  const logPath = path.join(tempDir, 'shadow.jsonl');

  const evaluator = new ShadowEvaluator({
    config: { shadow: { enabled: true }, openai: { default_model: 'gpt-5.4' } },
    logPath,
    log: silentLog,
    now: () => 1000,
    fetchCodex: () => Promise.resolve({
      model: 'gpt-5.4',
      choices: [{ message: { content: 'hello world' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }),
  });

  const ctx = evaluator.maybeStart(makeClassification(), makeBody());
  ctx.observeChunk(Buffer.from(
    'event: content_block_delta\n' +
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello world"}}\n\n',
  ));

  await ctx.complete();

  const lines = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const record = lines[0];
  assert.equal(record.status, 'ok');
  assert.deepEqual(record.divergences, []);
  assert.equal(record.min_similarity, 1);
  assert.equal(record.warning, false);
  assert.deepEqual(record.codex_usage, { prompt_tokens: 10, completion_tokens: 2 });
});
