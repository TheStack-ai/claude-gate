import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const CACHE_HIT_RATE_TARGET = 0.5;
const AGENT_RATIO_TARGET = 0.4;
const RETRY_COUNT_TARGET = 3;
const CONTEXT_GROWTH_TARGET = 10_000;
const FAST_MODE_RATIO_TARGET = 0.5;
const HEALTHY_TTFB_MS = 2_000;

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatPercent(value) {
  return `${Math.round(value * 100)}%`;
}

function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatContextGrowth(tokensPerTurn) {
  if (Math.abs(tokensPerTurn) >= 1000) {
    return `${(tokensPerTurn / 1000).toFixed(1)}K/턴`;
  }

  return `${Math.round(tokensPerTurn).toLocaleString()} 토큰/턴`;
}

function isAgentQuerySource(querySource) {
  return typeof querySource === 'string' && querySource.startsWith('agent:');
}

function createSessionState() {
  return {
    turns: 0,
    retryCount: 0,
    lastInputTokens: null,
    contextGrowthSum: 0,
    contextGrowthCount: 0,
  };
}

export function createAdvisorState() {
  return {
    turns: 0,
    cacheHitRateSum: 0,
    agentTurns: 0,
    fastTurns: 0,
    ttfbMsSum: 0,
    ttfbCount: 0,
    sessions: new Map(),
  };
}

export function ingestAdvisorRecord(state, record) {
  state.turns += 1;
  state.cacheHitRateSum += toNumber(record.cache_hit_rate);

  if (isAgentQuerySource(record.query_source)) {
    state.agentTurns += 1;
  }

  if (record.speed === 'fast') {
    state.fastTurns += 1;
  }

  if (record.ttfb_ms != null && Number.isFinite(Number(record.ttfb_ms))) {
    state.ttfbMsSum += Number(record.ttfb_ms);
    state.ttfbCount += 1;
  }

  const sessionId = record.session_id ?? 'unknown';
  const session = state.sessions.get(sessionId) ?? createSessionState();
  session.turns += 1;

  if (record.is_retry) {
    session.retryCount += 1;
  }

  const inputTokens = toNumber(record.input_tokens);
  if (session.lastInputTokens !== null) {
    session.contextGrowthSum += inputTokens - session.lastInputTokens;
    session.contextGrowthCount += 1;
  }

  session.lastInputTokens = inputTokens;
  state.sessions.set(sessionId, session);
}

export function summarizeAdvisorState(state) {
  let maxRetriesPerSession = 0;
  let contextGrowthSum = 0;
  let contextGrowthCount = 0;

  for (const session of state.sessions.values()) {
    if (session.retryCount > maxRetriesPerSession) {
      maxRetriesPerSession = session.retryCount;
    }

    contextGrowthSum += session.contextGrowthSum;
    contextGrowthCount += session.contextGrowthCount;
  }

  return {
    turns: state.turns,
    sessionCount: state.sessions.size,
    cacheHitRate: state.turns > 0 ? state.cacheHitRateSum / state.turns : null,
    agentWorkerRatio: state.turns > 0 ? state.agentTurns / state.turns : null,
    maxRetriesPerSession,
    contextGrowthRate: contextGrowthCount > 0 ? contextGrowthSum / contextGrowthCount : null,
    fastModeRatio: state.turns > 0 ? state.fastTurns / state.turns : null,
    avgTtfbMs: state.ttfbCount > 0 ? state.ttfbMsSum / state.ttfbCount : null,
  };
}

export function createAdvisorFindings(summary) {
  if (!summary.turns) {
    return [
      {
        icon: '💡',
        message: '분석 가능한 요청이 없습니다 — 로그 파일 또는 수집 기간을 확인하세요',
      },
    ];
  }

  const findings = [];

  if (summary.cacheHitRate < CACHE_HIT_RATE_TARGET) {
    findings.push({
      icon: '⚠',
      message: `캐시 히트율 ${formatPercent(summary.cacheHitRate)} (목표: 50%+) — CLAUDE.md 동적 섹션 크기 확인 권장`,
    });
  } else {
    findings.push({
      icon: '✓',
      message: `캐시 히트율 ${formatPercent(summary.cacheHitRate)} (목표: 50%+) — 정상 범위`,
    });
  }

  if (summary.agentWorkerRatio > AGENT_RATIO_TARGET) {
    findings.push({
      icon: '⚠',
      message: `Agent Worker 비율 ${formatPercent(summary.agentWorkerRatio)} — Codex 라우팅 활성화 시 Anthropic 부하 절반`,
    });
  } else {
    findings.push({
      icon: '✓',
      message: `Agent Worker 비율 ${formatPercent(summary.agentWorkerRatio)} — 라우팅 필요성은 아직 낮음`,
    });
  }

  if (summary.maxRetriesPerSession > RETRY_COUNT_TARGET) {
    findings.push({
      icon: '⚠',
      message: `세션당 최대 재시도 ${summary.maxRetriesPerSession}회 — 529 폴백 활성화 권장`,
    });
  } else {
    findings.push({
      icon: '✓',
      message: `세션당 최대 재시도 ${summary.maxRetriesPerSession}회 — 정상 범위`,
    });
  }

  if ((summary.contextGrowthRate ?? 0) > CONTEXT_GROWTH_TARGET) {
    findings.push({
      icon: '⚠',
      message: `컨텍스트 증가율 ${formatContextGrowth(summary.contextGrowthRate)} — compaction 타이밍 조기화 검토`,
    });
  } else {
    findings.push({
      icon: '✓',
      message: `컨텍스트 증가율 ${formatContextGrowth(summary.contextGrowthRate ?? 0)} — 정상 범위`,
    });
  }

  if (summary.fastModeRatio > FAST_MODE_RATIO_TARGET) {
    findings.push({
      icon: '⚠',
      message: `Fast mode 활성 턴 ${formatPercent(summary.fastModeRatio)} — Fast mode 6배 과금 주의`,
    });
  } else {
    findings.push({
      icon: '✓',
      message: `Fast mode 활성 턴 ${formatPercent(summary.fastModeRatio)} — 비용 리스크 낮음`,
    });
  }

  if (summary.avgTtfbMs == null) {
    findings.push({
      icon: '💡',
      message: '평균 TTFB를 계산할 데이터가 없습니다 — 스트리밍 첫 바이트 로그를 확인하세요',
    });
  } else if (summary.avgTtfbMs <= HEALTHY_TTFB_MS) {
    findings.push({
      icon: '✓',
      message: `평균 TTFB ${formatSeconds(summary.avgTtfbMs)} — 정상 범위`,
    });
  } else {
    findings.push({
      icon: '💡',
      message: `평균 TTFB ${formatSeconds(summary.avgTtfbMs)} — 업스트림 지연 또는 네트워크 상태 점검 권장`,
    });
  }

  return findings;
}

export async function loadMetricsRecords(logPath) {
  const records = [];
  const rl = createInterface({
    input: createReadStream(logPath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }

    try {
      records.push(JSON.parse(line));
    } catch {
      // Ignore malformed lines so advisor keeps working on partial logs.
    }
  }

  return records;
}

export function analyzeMetricsRecords(records = []) {
  const state = createAdvisorState();

  for (const record of records) {
    ingestAdvisorRecord(state, record);
  }

  const summary = summarizeAdvisorState(state);
  const findings = createAdvisorFindings(summary);
  return {
    summary,
    findings,
  };
}

export function formatAdvisorLines(findings = []) {
  return findings.map((finding) => `${finding.icon} ${finding.message}`);
}

export async function adviseFromLog({ logPath }) {
  await fs.access(logPath);
  const records = await loadMetricsRecords(logPath);
  const analysis = analyzeMetricsRecords(records);

  return {
    ...analysis,
    lines: formatAdvisorLines(analysis.findings),
  };
}
