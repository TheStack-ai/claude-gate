import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';

import { adviseFromLog, analyzeMetricsRecords, formatAdvisorLines, loadMetricsRecords } from '../src/advisor.mjs';

test('analyzeMetricsRecords generates warnings from Phase 3 advisor rules', () => {
  const analysis = analyzeMetricsRecords([
    {
      session_id: 'session-a',
      query_source: 'agent:custom',
      input_tokens: 10_000,
      cache_hit_rate: 0.4,
      is_retry: true,
      speed: 'fast',
      ttfb_ms: 1_100,
    },
    {
      session_id: 'session-a',
      query_source: 'agent:default',
      input_tokens: 25_000,
      cache_hit_rate: 0.42,
      is_retry: true,
      speed: 'fast',
      ttfb_ms: 1_300,
    },
    {
      session_id: 'session-a',
      query_source: 'repl_main_thread',
      input_tokens: 40_000,
      cache_hit_rate: 0.43,
      is_retry: true,
      speed: 'fast',
      ttfb_ms: 1_200,
    },
    {
      session_id: 'session-a',
      query_source: 'repl_main_thread',
      input_tokens: 55_000,
      cache_hit_rate: 0.39,
      is_retry: true,
      speed: null,
      ttfb_ms: 1_000,
    },
    {
      session_id: 'session-b',
      query_source: 'agent:custom',
      input_tokens: 18_000,
      cache_hit_rate: 0.41,
      is_retry: false,
      speed: 'fast',
      ttfb_ms: 1_400,
    },
  ]);

  const lines = formatAdvisorLines(analysis.findings);

  assert.equal(analysis.summary.turns, 5);
  assert.equal(analysis.summary.maxRetriesPerSession, 4);
  assert.match(lines[0], /⚠ 캐시 히트율 41%/);
  assert.match(lines[1], /⚠ Agent Worker 비율 60%/);
  assert.match(lines[2], /⚠ 세션당 최대 재시도 4회/);
  assert.match(lines[3], /⚠ 컨텍스트 증가율 15\.0K\/턴/);
  assert.match(lines[4], /⚠ Fast mode 활성 턴 80%/);
  assert.match(lines[5], /✓ 평균 TTFB 1\.2s/);
});

test('adviseFromLog reads JSONL, ignores malformed lines, and formats Korean output', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'claude-proxy-advisor-'));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const logPath = path.join(tempDir, 'metrics.jsonl');
  await writeFile(logPath, [
    JSON.stringify({
      session_id: 'session-1',
      query_source: 'repl_main_thread',
      input_tokens: 1000,
      cache_hit_rate: 0.9,
      is_retry: false,
      speed: null,
      ttfb_ms: 2500,
    }),
    '{not-json}',
    JSON.stringify({
      session_id: 'session-1',
      query_source: 'repl_main_thread',
      input_tokens: 1200,
      cache_hit_rate: 0.8,
      is_retry: false,
      speed: null,
      ttfb_ms: 2600,
    }),
  ].join('\n'));

  const records = await loadMetricsRecords(logPath);
  assert.equal(records.length, 2);

  const result = await adviseFromLog({ logPath });
  assert.match(result.lines[0], /✓ 캐시 히트율 85%/);
  assert.match(result.lines.at(-1), /💡 평균 TTFB 2\.5s/);
});
