import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { ShadowEvaluator } from '../src/shadow.mjs';
import { makeBody, makeClassification, makeTempDir, silentLog } from './shadow-test-helpers.mjs';

test('shadow logs ok result with divergence on tool_choice', async (t) => {
  const tempDir = await makeTempDir(t);
  const logPath = path.join(tempDir, 'shadow.jsonl');
  let timeValue = 1000;

  const evaluator = new ShadowEvaluator({
    config: { shadow: { enabled: true }, openai: { default_model: 'gpt-5.4' } },
    logPath,
    log: silentLog,
    now: () => timeValue++,
    fetchCodex: () => Promise.resolve({
      model: 'gpt-5.4',
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'Write', arguments: '{}' },
          }],
        },
      }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }),
  });

  const ctx = evaluator.maybeStart(makeClassification(), makeBody());
  ctx.observeChunk(Buffer.from(
    'event: content_block_start\n' +
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"Read","input":{}}}\n\n',
  ));

  await ctx.complete();

  const lines = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  const record = lines[0];
  assert.equal(record.status, 'ok');
  assert.equal(record.session_id, 'session-1');
  assert.equal(record.request_id, 'req-1');
  assert.equal(record.model_codex, 'gpt-5.4');
  assert.equal(record.divergences.length, 1);
  assert.equal(record.divergences[0].divergence_type, 'tool_choice');
  assert.equal(record.divergences[0].anthropic_tool, 'Read');
  assert.equal(record.divergences[0].codex_tool, 'Write');
});

test('shadow logs ok result with content divergence', async (t) => {
  const tempDir = await makeTempDir(t);
  const logPath = path.join(tempDir, 'shadow.jsonl');

  const evaluator = new ShadowEvaluator({
    config: { shadow: { enabled: true }, openai: { default_model: 'gpt-5.4' } },
    logPath,
    log: silentLog,
    now: () => 1000,
    fetchCodex: () => Promise.resolve({
      model: 'gpt-5.4',
      choices: [{ message: { content: 'completely different response text here' } }],
      usage: {},
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
  const contentDiv = record.divergences.find((divergence) => divergence.divergence_type === 'output_content');
  assert.ok(contentDiv);
  assert.ok(contentDiv.similarity_score < 1);
});

test('shadow logs error when codex returns null', async (t) => {
  const tempDir = await makeTempDir(t);
  const logPath = path.join(tempDir, 'shadow.jsonl');

  const evaluator = new ShadowEvaluator({
    config: { shadow: { enabled: true }, openai: {} },
    logPath,
    log: silentLog,
    now: () => 1000,
    fetchCodex: () => Promise.resolve(null),
  });

  const ctx = evaluator.maybeStart(makeClassification(), makeBody());
  await ctx.complete();

  const lines = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines[0].status, 'error');
  assert.equal(lines[0].error, 'no_response');
});

test('shadow logs error when codex returns API error', async (t) => {
  const tempDir = await makeTempDir(t);
  const logPath = path.join(tempDir, 'shadow.jsonl');

  const evaluator = new ShadowEvaluator({
    config: { shadow: { enabled: true }, openai: {} },
    logPath,
    log: silentLog,
    now: () => 1000,
    fetchCodex: () => Promise.resolve({ error: { message: 'rate_limit_exceeded' } }),
  });

  const ctx = evaluator.maybeStart(makeClassification(), makeBody());
  await ctx.complete();

  const lines = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines[0].status, 'error');
  assert.equal(lines[0].error, 'rate_limit_exceeded');
});
