# Phases Spec: Implementation Roadmap

## Phase 1: Observe + Shadow

### Scope
- HTTP 패스스루 프록시 (body 무수정)
- 턴별 메트릭 로깅 (JSONL)
- querySource 기반 요청 분류
- Codex shadow evaluation (비교만, 응답 대체 없음)
- CLI 실시간 메트릭 출력

### Artifacts
- `src/proxy.mjs` — 메인 프록시 서버
- `src/logger.mjs` — JSONL 메트릭 로거
- `src/classifier.mjs` — querySource 파서 + 요청 분류기
- `src/shadow.mjs` — Codex shadow evaluation 엔진
- `src/format.mjs` — Anthropic→OpenAI 요청 변환 (shadow용)
- `.proxy.config.json` — 설정 파일
- `bin/claude-proxy` — CLI 엔트리포인트

### 실행 방법
```bash
# 프록시 시작
claude-proxy start

# Claude Code 실행 (다른 터미널 또는 같은 터미널)
ANTHROPIC_BASE_URL=http://localhost:8080 claude

# 메트릭 조회
claude-proxy stats
claude-proxy stats --session <session-id>
```

### Success Criteria
- 프록시 경유 시 추가 지연 < 50ms (p95)
- 모든 Claude Code 기능 정상 동작 (도구, 스킬, 플러그인)
- Shadow eval 결과가 로그에 기록됨
- `claude-proxy stats`로 세션 메트릭 조회 가능
- `agent_request_ratio` 측정으로 Phase 2 토큰 절약 효과 예측 가능

### Duration: 1주

---

## Phase 2: Route + Fallback

### Scope
- Agent Worker → Codex 선택적 라우팅 (allowlist 기반)
- OpenAI→Anthropic 응답 변환 (스트리밍 포함)
- 529 에러 시 Codex 폴백
- 로컬 TUI 대시보드 (실시간 메트릭)

### Artifacts
- `src/router.mjs` — 라우팅 엔진 (규칙 기반)
- `src/format-response.mjs` — OpenAI→Anthropic 응답 변환
- `src/stream-converter.mjs` — SSE 스트리밍 변환 (OpenAI→Anthropic)
- `src/fallback.mjs` — 529 폴백 핸들러
- `src/dashboard.mjs` — TUI 대시보드 (blessed 또는 ink)

### 실행 방법
```bash
# 라우팅 활성화
claude-proxy config set routing.enabled true

# 폴백 활성화
claude-proxy config set fallback_529.enabled true

# 대시보드
claude-proxy dashboard
```

### Success Criteria
- Codex 라우팅된 Agent Worker의 작업 성공률이 Claude 대비 ±5% 이내
- 스트리밍 변환이 Claude Code UI에서 정상 렌더링
- 529 폴백 시 사용자 체감 중단 없음
- 대시보드에서 실시간 요청 흐름 확인 가능
- Anthropic 토큰 소모가 라우팅된 Agent Worker 비율만큼 감소 (목표: 40%+)

### Prerequisite: Phase 1 데이터에서 Agent Worker 비율 + 성공률 확인
### Duration: 2주

---

## Phase 3: Optimize + Distribute

### Scope
- Phase 1-2 데이터 기반 캐시 히트율 최적화 권고
- 재시도 응답 캐싱 (같은 request-id)
- 오픈소스 공개 준비 (clean-room 문서, README)
- npm 패키지 배포

### Artifacts
- `src/cache.mjs` — 재시도 응답 캐시
- `src/advisor.mjs` — 최적화 권고 엔진 (캐시, CLAUDE.md 배치 등)
- `README.md` — 공개용 문서 (clean-room 원칙)
- `package.json` — npm 패키지 설정

### 실행 방법
```bash
# 최적화 권고
claude-proxy advise

# 출력 예시:
# ⚠ 캐시 히트율 41% (턴 3) — CLAUDE.md 동적 섹션 크기 확인 권장
# ⚠ Agent Worker 비율 45% — Codex 라우팅 활성화 시 Anthropic 부하 절반
# ✓ 평균 TTFB 1.2s — 정상 범위
```

### Success Criteria
- npm install -g로 설치 가능
- README에 내부 소스 유래 표현 없음
- 재시도 캐싱으로 529 시 추가 토큰 소모 0
- `claude-proxy advise`가 실행 가능한 권고 3개 이상 제공

### Prerequisite: Phase 2 완료 + 2주 이상 실사용 데이터
### Duration: 2주

---

## Phase Summary

| Phase | 핵심 | 기간 | Codex 활용 | Anthropic 토큰 절약 |
|-------|------|------|-----------|-------------------|
| 1 | 관찰 + Shadow eval | 1주 | 비교만 (대체 없음) | 측정 (baseline) |
| 2 | 라우팅 + 폴백 | 2주 | Agent Worker 자동 라우팅 | Agent 비율만큼 절감 (목표 40%+) |
| 3 | 최적화 + 공개 | 2주 | 전체 통합 + 배포 | 캐싱 추가 절감 |
