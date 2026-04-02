import { createReadStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_LOG_PATH = path.join(os.homedir(), '.claude-gate', 'logs', 'metrics.jsonl');

// ── ANSI helpers ──

const ESC = '\x1b[';

function shouldUseAnsi() {
  return Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
}

function createAnsi(enabled) {
  const color = (code) => (enabled ? `${ESC}${code}m` : '');
  return {
    enabled,
    RESET: color('0'),
    BOLD: color('1'),
    DIM: color('2'),
    GREEN: color('32'),
    RED: color('31'),
    YELLOW: color('33'),
    CYAN: color('36'),
    clear() {
      if (enabled) process.stdout.write(`${ESC}2J${ESC}H`);
    },
    moveTo(row, col) {
      if (enabled) process.stdout.write(`${ESC}${row};${col}H`);
    },
    hideCursor() {
      if (enabled) process.stdout.write(`${ESC}?25l`);
    },
    showCursor() {
      if (enabled) process.stdout.write(`${ESC}?25h`);
    },
  };
}

const ANSI = createAnsi(shouldUseAnsi());
const { RESET, BOLD, DIM, GREEN, RED, YELLOW, CYAN } = ANSI;

// ── i18n ──

const TRANSLATIONS = {
  en: {
    locale: 'en-GB',
    title: 'Claude Gate v1.0.0',
    querySource: {
      repl_main_thread: 'Direct conversation',
      compact: 'Context compression',
      verification_agent: 'Verification',
      agentTask: (agentSeq) => `Agent task (#${agentSeq})`,
      agentTaskLabel: 'Agent task',
      unknown: 'Unknown',
    },
    routedTo: {
      anthropic: 'Claude',
      openai: 'Codex',
      openai_fallback: 'Codex',
      unknown: '?',
    },
    tags: {
      openai: 'Saved!',
      openai_fallback: '529 recovered!',
    },
    sections: {
      liveActivity: 'Live Activity',
      sessionSummary: 'Session Summary',
      savings: 'Savings',
    },
    status: {
      running: (elapsed) => `${elapsed} running`,
      waiting: 'Waiting for requests...',
      totalConversations: 'Total conversations',
      allClaude: 'all Claude',
      savedViaCodex: (count) => `${count} saved via Codex`,
      claudeUsage: 'Claude usage',
      codexUsage: 'Codex usage',
      savedClaudeTokens: 'Claude tokens saved',
      fallbackRecoveries: '529 recoveries',
      rescuedWork: 'rescued stalled work',
      cacheHitRate: 'Cache hit rate',
      dashboardStopped: 'Dashboard stopped.',
      keyHintsInteractive: 'q quit   r refresh   Ctrl+C exit',
      keyHintsPassive: 'Ctrl+C exit',
    },
  },
  ko: {
    locale: 'ko-KR',
    title: 'Claude Gate v1.0.0',
    querySource: {
      repl_main_thread: '대표님 직접 대화',
      compact: '맥락 압축',
      verification_agent: '검증 작업',
      agentTask: (agentSeq) => `AI 보조작업 (#${agentSeq})`,
      agentTaskLabel: 'AI 보조작업',
      unknown: '알 수 없음',
    },
    routedTo: {
      anthropic: 'Claude',
      openai: 'Codex',
      openai_fallback: 'Codex',
      unknown: '?',
    },
    tags: {
      openai: '절약!',
      openai_fallback: '529복구!',
    },
    sections: {
      liveActivity: '지금 일어나는 일',
      sessionSummary: '이번 세션 요약',
      savings: '절약 효과',
    },
    status: {
      running: (elapsed) => `${elapsed}째 실행 중`,
      waiting: '요청 대기 중...',
      totalConversations: '총 대화 횟수',
      allClaude: '전부 Claude',
      savedViaCodex: (count) => `${count}회 Codex로 절약`,
      claudeUsage: 'Claude 사용량',
      codexUsage: 'Codex 활용',
      savedClaudeTokens: '절약한 Claude 토큰',
      fallbackRecoveries: '529 에러 복구',
      rescuedWork: '멈출 뻔한 작업 살림',
      cacheHitRate: '캐시 히트율',
      dashboardStopped: 'dashboard 종료.',
      keyHintsInteractive: 'q 종료   r 새로고침   Ctrl+C 종료',
      keyHintsPassive: 'Ctrl+C 종료',
    },
  },
};

function normalizeLang(lang) {
  return typeof lang === 'string' && lang.toLowerCase() === 'ko' ? 'ko' : 'en';
}

function getTranslations(lang) {
  return TRANSLATIONS[normalizeLang(lang)];
}

// ── Label translation ──

export function translateQuerySource(qs, agentSeq, lang = 'en') {
  const t = getTranslations(lang);
  if (qs === 'repl_main_thread') return t.querySource.repl_main_thread;
  if (qs === 'compact') return t.querySource.compact;
  if (qs === 'verification_agent') return t.querySource.verification_agent;
  if (typeof qs === 'string' && qs.startsWith('agent:')) return t.querySource.agentTask(agentSeq);
  return qs || t.querySource.unknown;
}

export function translateRoutedTo(routedTo, lang = 'en') {
  const t = getTranslations(lang);
  if (routedTo === 'anthropic') return t.routedTo.anthropic;
  if (routedTo === 'openai') return t.routedTo.openai;
  if (routedTo === 'openai_fallback') return t.routedTo.openai_fallback;
  return routedTo || t.routedTo.unknown;
}

function routeTag(routedTo, lang = 'en') {
  const t = getTranslations(lang);
  if (routedTo === 'openai') return `${GREEN}${t.tags.openai}${RESET}`;
  if (routedTo === 'openai_fallback') return `${YELLOW}${t.tags.openai_fallback}${RESET}`;
  return '';
}

function statusIcon(status) {
  if (status >= 200 && status < 400) return `${GREEN}✓${RESET}`;
  if (status === 529) return `${YELLOW}⟳${RESET}`;
  return `${RED}✗${RESET}`;
}

// ── Progress bar ──

export function progressBar(ratio, width = 20) {
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

// ── Session state ──

export function createSessionState(options = {}) {
  return {
    lang: normalizeLang(options.lang),
    turns: 0,
    directCount: 0,
    agentCount: 0,
    codexRoutedCount: 0,
    fallbackCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    codexSavedTokens: 0,
    cacheHitSum: 0,
    retryCount: 0,
    agentSeq: 0,
    recentEvents: [],
    startedAt: Date.now(),
  };
}

export function ingestRecord(state, record) {
  const lang = normalizeLang(state.lang);
  const t = getTranslations(lang);
  state.turns += 1;

  const isAgent = typeof record.query_source === 'string' && record.query_source.startsWith('agent:');
  if (isAgent) {
    state.agentCount += 1;
    state.agentSeq += 1;
  } else {
    state.directCount += 1;
  }

  if (record.routed_to === 'openai') {
    state.codexRoutedCount += 1;
    state.codexSavedTokens += (record.input_tokens || 0) + (record.output_tokens || 0);
  }
  if (record.routed_to === 'openai_fallback') {
    state.fallbackCount += 1;
    state.codexSavedTokens += (record.input_tokens || 0) + (record.output_tokens || 0);
  }

  state.totalInputTokens += record.input_tokens || 0;
  state.totalOutputTokens += record.output_tokens || 0;
  state.cacheHitSum += record.cache_hit_rate || 0;
  if (record.is_retry) state.retryCount += 1;

  const time = record.ts ? new Date(record.ts).toLocaleTimeString(t.locale, { hour12: false }) : '--:--:--';
  state.recentEvents.push({
    time,
    label: translateQuerySource(record.query_source, state.agentSeq, lang),
    target: translateRoutedTo(record.routed_to, lang),
    tag: routeTag(record.routed_to, lang),
    icon: statusIcon(record.status || 200),
    routedTo: record.routed_to,
  });

  if (state.recentEvents.length > 10) state.recentEvents.shift();
}

// ── Render ──

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function elapsedStr(ms, lang = 'en') {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (lang === 'ko') {
    if (h > 0) return `${h}시간 ${m % 60}분`;
    if (m > 0) return `${m}분 ${s % 60}초`;
    return `${s}초`;
  }
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function fitText(str, len) {
  if (str.length <= len) return str.padEnd(len, ' ');
  if (len <= 3) return str.slice(0, len);
  return `${str.slice(0, len - 3)}...`;
}

function renderFrame(state, cols, keyboardEnabled) {
  const t = getTranslations(state.lang);
  const w = Math.max(40, Math.min(cols - 2, 62));
  const pad = (str, len) => {
    const visible = stripAnsi(str);
    return str + ' '.repeat(Math.max(0, len - visible.length));
  };
  const hr = '─'.repeat(w);
  const lines = [];

  const directPct = state.turns > 0 ? Math.round(state.directCount / state.turns * 100) : 0;
  const agentPct = state.turns > 0 ? Math.round(state.agentCount / state.turns * 100) : 0;
  const claudeRatio = state.turns > 0 ? state.directCount / state.turns : 0;
  const codexRatio = state.turns > 0 ? (state.codexRoutedCount + state.fallbackCount) / state.turns : 0;
  const avgCacheHit = state.turns > 0 ? (state.cacheHitSum / state.turns * 100).toFixed(1) : '0.0';
  const fallbackSuffix = state.fallbackCount > 0 ? ` (${t.status.rescuedWork})` : '';
  const footerHints = keyboardEnabled ? t.status.keyHintsInteractive : t.status.keyHintsPassive;

  lines.push(`${CYAN}╭${'─'.repeat(w)}╮${RESET}`);
  lines.push(`${CYAN}│${RESET}${BOLD}${pad(`  ${t.title}`, w)}${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${RESET}${DIM}${pad(`  ${t.status.running(elapsedStr(Date.now() - state.startedAt, state.lang))}`, w)}${RESET}${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${pad('', w)}│${RESET}`);

  // Live events
  lines.push(`${CYAN}│${RESET}${pad(`  ${BOLD}💬 ${t.sections.liveActivity}${RESET}`, w)}${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${RESET}  ${DIM}${hr.slice(0, w - 4)}${RESET}  ${CYAN}│${RESET}`);

  if (state.recentEvents.length === 0) {
    lines.push(`${CYAN}│${RESET}${DIM}${pad(`  ${t.status.waiting}`, w)}${RESET}${CYAN}│${RESET}`);
  } else {
    for (const evt of state.recentEvents.slice(-8)) {
      const entry = `  ${DIM}${evt.time}${RESET}  ${fitText(evt.label, 20)} -> ${BOLD}${fitText(evt.target, 6)}${RESET}  ${evt.icon} ${evt.tag}`.trimEnd();
      lines.push(`${CYAN}│${RESET}${pad(entry, w)}${CYAN}│${RESET}`);
    }
  }

  lines.push(`${CYAN}│${pad('', w)}│${RESET}`);

  // Session summary
  lines.push(`${CYAN}│${RESET}${pad(`  ${BOLD}📊 ${t.sections.sessionSummary}${RESET}`, w)}${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${RESET}  ${DIM}${hr.slice(0, w - 4)}${RESET}  ${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${RESET}${pad(`  ${fitText(t.status.totalConversations, 22)}${state.turns}`, w)}${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${RESET}${pad(`  ├ ${fitText(t.querySource.repl_main_thread, 18)} ${state.directCount} (${directPct}%)   -> ${t.status.allClaude}`, w)}${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${RESET}${pad(`  └ ${fitText(t.querySource.agentTaskLabel, 18)} ${state.agentCount} (${agentPct}%)   -> ${t.status.savedViaCodex(state.codexRoutedCount)}`, w)}${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${pad('', w)}│${RESET}`);
  lines.push(`${CYAN}│${RESET}${pad(`  ${fitText(t.status.claudeUsage, 20)}${progressBar(claudeRatio)}  ${Math.round(claudeRatio * 100)}%`, w)}${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${RESET}${pad(`  ${fitText(t.status.codexUsage, 20)}${GREEN}${progressBar(codexRatio)}${RESET}  ${Math.round(codexRatio * 100)}%`, w)}${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${pad('', w)}│${RESET}`);

  // Savings
  lines.push(`${CYAN}│${RESET}${pad(`  ${BOLD}💰 ${t.sections.savings}${RESET}`, w)}${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${RESET}  ${DIM}${hr.slice(0, w - 4)}${RESET}  ${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${RESET}${pad(`  ${fitText(t.status.savedClaudeTokens, 24)}${GREEN}${formatTokens(state.codexSavedTokens)}${RESET}`, w)}${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${RESET}${pad(`  ${fitText(t.status.fallbackRecoveries, 24)}${state.fallbackCount}${fallbackSuffix}`, w)}${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${RESET}${pad(`  ${fitText(t.status.cacheHitRate, 24)}${avgCacheHit}%`, w)}${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${pad('', w)}│${RESET}`);
  lines.push(`${CYAN}│${RESET}${DIM}${pad(`  ${footerHints}`, w)}${RESET}${CYAN}│${RESET}`);
  lines.push(`${CYAN}╰${'─'.repeat(w)}╯${RESET}`);

  return lines;
}

// ── Main loop ──

export async function startDashboard(options = {}) {
  const logPath = options.logPath || DEFAULT_LOG_PATH;
  const sessionFilter = options.session || null;
  const fresh = options.fresh || false;
  const lang = normalizeLang(options.lang);
  const state = createSessionState({ lang });
  const keyboardEnabled = Boolean(process.stdin.isTTY && typeof process.stdin.setRawMode === 'function');
  let fileSize = 0;
  let cleanedUp = false;
  let lastFrame = '';
  let refreshInFlight = null;

  // Initial read of existing log (skip if --fresh)
  if (!fresh) {
    try {
      statSync(logPath);
      const rl = createInterface({ input: createReadStream(logPath), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (sessionFilter && record.session_id !== sessionFilter) continue;
          ingestRecord(state, record);
        } catch {}
      }
    } catch {}
  }

  try { fileSize = statSync(logPath).size; } catch {}

  // Setup terminal
  ANSI.hideCursor();
  ANSI.clear();

  const draw = (force = false) => {
    const currentCols = process.stdout.columns || 80;
    const frame = renderFrame(state, currentCols, keyboardEnabled).join('\n');

    if (ANSI.enabled) {
      ANSI.moveTo(1, 1);
      process.stdout.write(frame + '\n');
    } else if (force || frame !== lastFrame) {
      if (lastFrame) process.stdout.write('\n');
      process.stdout.write(frame + '\n');
    }

    lastFrame = frame;
  };

  const refreshFromLog = async (forceDraw = false) => {
    if (refreshInFlight) {
      if (forceDraw) {
        await refreshInFlight;
        draw(true);
      }
      return;
    }

    refreshInFlight = (async () => {
      let changed = false;
      let currentSize;
      try {
        currentSize = statSync(logPath).size;
      } catch {
        if (forceDraw) draw(true);
        return;
      }

      if (currentSize > fileSize) {
        const stream = createReadStream(logPath, { start: fileSize });
        fileSize = currentSize;
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        for await (const line of rl) {
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line);
            if (sessionFilter && record.session_id !== sessionFilter) continue;
            ingestRecord(state, record);
            changed = true;
          } catch {}
        }
      }

      if (changed || forceDraw) draw(forceDraw);
    })();

    try {
      await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  };

  draw(true);

  // Watch for log changes
  const pollInterval = setInterval(() => {
    void refreshFromLog(false);
  }, 1000);

  // Timer update
  const timerInterval = setInterval(() => draw(!ANSI.enabled), 5000);

  // Resize
  const onResize = () => {
    ANSI.clear();
    draw(true);
  };
  process.stdout.on('resize', onResize);

  const onKeypress = (chunk) => {
    const key = String(chunk);
    if (key === '\u0003') {
      cleanup();
      process.exit(0);
    }
    if (key.toLowerCase() === 'q') {
      cleanup();
      process.exit(0);
    }
    if (key.toLowerCase() === 'r') {
      void refreshFromLog(true);
    }
  };

  if (keyboardEnabled) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onKeypress);
  }

  // Cleanup
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;

    clearInterval(pollInterval);
    clearInterval(timerInterval);
    process.stdout.off('resize', onResize);

    if (keyboardEnabled) {
      process.stdin.off('data', onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }

    ANSI.showCursor();
    ANSI.clear();
    console.log(getTranslations(lang).status.dashboardStopped);
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  return { state, cleanup };
}
