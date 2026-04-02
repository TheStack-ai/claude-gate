# Change: Phase 2 — Active Routing + 529 Fallback

## Summary

Phase 1 데이터를 기반으로, Agent Worker 요청을 Codex로 실제 라우팅하고 529 에러 시 Codex 폴백을 구현한다.

## Motivation

- Phase 1 shadow eval에서 Codex 대체 가능성이 확인된 요청군을 실제로 라우팅
- 529 에러 시 재시도 대기 대신 Codex로 즉시 전환하여 작업 중단 방지
- 두 구독(Max + Codex Pro)의 rate limit을 동시에 활용

## Prerequisite

- Phase 1 완료
- Shadow eval 데이터에서 Agent Worker Codex 대체 성공률 ±5% 이내 확인

## Affected Specs

- [codex-integration](../../specs/codex-integration.md) — Active Routing, 529 Fallback
- [phases](../../specs/phases.md) — Phase 2

## Artifacts

| File | Description | Status |
|------|-------------|--------|
| `src/router.mjs` | 규칙 기반 라우팅 엔진 | DONE |
| `src/format-response.mjs` | OpenAI→Anthropic 응답 변환 | DONE |
| `src/stream-converter.mjs` | SSE 스트리밍 변환 (OpenAI→Anthropic) | DONE |
| `src/fallback.mjs` | 529 폴백 핸들러 | DONE |
| `src/dashboard.mjs` | TUI 실시간 대시보드 (한국어, 일반인 친화) | DONE |

## Acceptance Criteria

1. Codex 라우팅된 Agent Worker 작업 성공률이 Claude 대비 ±5% 이내
2. OpenAI→Anthropic 스트리밍 변환이 Claude Code UI에서 정상 렌더링
3. 529 폴백 시 사용자 체감 중단 없음
4. 부분 스트리밍 중 폴백 시도하지 않음 (race condition 방지)
5. `claude-proxy dashboard`에서 실시간 요청 흐름 확인 가능
6. 라우팅 규칙을 `.proxy.config.json`에서 on/off 전환 가능
