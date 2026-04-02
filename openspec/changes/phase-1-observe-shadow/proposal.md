# Change: Phase 1 — Observe + Shadow Evaluation

## Summary

로컬 패스스루 프록시를 구축하여 Claude Code API 트래픽을 관찰하고, Agent Worker 요청에 대해 Codex shadow evaluation을 실행한다.

## Motivation

- Claude Code 사용 시 턴별 토큰 사용량, 캐시 히트율, Agent 패턴이 보이지 않음
- Codex Pro 구독이 있지만 `/codex:review` 수동 호출에만 활용됨
- 프록시를 통해 자동 관찰 + Codex 자동 비교가 가능

## Affected Specs

- [architecture](../../specs/architecture.md)
- [metrics](../../specs/metrics.md)
- [codex-integration](../../specs/codex-integration.md) — Shadow Evaluation 부분만
- [phases](../../specs/phases.md) — Phase 1
- [strategy-constraints](../../specs/strategy-constraints.md)

## Design Contracts

1. **Body 무수정 (raw-byte pass-through)**: `src/proxy.mjs`는 request body를 한 바이트도 수정하지 않고 Anthropic API로 전달한다. Native Client Attestation(`cch` 해시) 통과를 보장하기 위함.
2. **SSE 관찰 방식**: `src/proxy.mjs`는 Anthropic의 response SSE 스트림을 클라이언트에 그대로 pipe하면서, tee(복제) 방식으로 관찰한다. 버퍼링하지 않는다 (p95 < 50ms 목표 유지).
3. **메트릭 수집 경로**: `src/logger.mjs`는 tee된 SSE 스트림에서 `message_start`(model), `message_delta`(usage, stop_reason) 이벤트를 파싱하여 메트릭을 추출한다. 전체 응답을 버퍼링하지 않고 이벤트 단위로 처리한다.
4. **OPENAI_API_KEY 미설정 시**: shadow eval이 graceful하게 비활성화된다. 프록시 핵심 기능(패스스루 + 로깅)은 정상 동작.

## Artifacts

| File | Description | Status |
|------|-------------|--------|
| `src/proxy.mjs` | HTTP 패스스루 프록시 서버 (raw-byte pass-through + SSE tee 관찰) | TODO |
| `src/logger.mjs` | JSONL 메트릭 로거 (SSE 이벤트 단위 수집) | TODO |
| `src/classifier.mjs` | querySource 파서 + 요청 분류기 | TODO |
| `src/shadow.mjs` | Codex shadow evaluation 엔진 | TODO |
| `src/format.mjs` | Anthropic→OpenAI 요청 변환 | TODO |
| `.proxy.config.json` | 기본 설정 파일 | TODO |
| `bin/claude-proxy` | CLI 엔트리포인트 | TODO |
| `package.json` | 프로젝트 메타데이터 | TODO |

## Acceptance Criteria

1. `ANTHROPIC_BASE_URL=http://localhost:8080 claude` 실행 시 모든 기능 정상 동작
2. 프록시 추가 지연 < 50ms (p95) — SSE tee 방식으로 버퍼링 없이 관찰
3. Request body를 raw bytes 그대로 전달 (body 무수정 invariant)
4. `claude-proxy stats`로 세션별 토큰, 캐시, 지연 메트릭 조회 가능
5. `agent_request_ratio` 측정으로 Phase 2 토큰 절약 효과 예측 가능
6. Agent Worker 요청이 자동 분류되어 로그에 기록됨
7. Shadow eval 대상: `querySource: agent:*` AND `tools.length <= 5` AND `thinking disabled` — 세 조건 모두 충족 시에만
8. Shadow eval 결과(Codex 비교)가 JSONL 로그에 기록됨
9. Shadow eval이 메인 응답 반환을 지연시키지 않음 (비동기)
10. `OPENAI_API_KEY` 미설정 시 shadow eval만 비활성, 프록시 + 로깅은 정상 동작
