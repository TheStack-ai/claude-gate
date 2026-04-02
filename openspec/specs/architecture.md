# Architecture Spec: Claude Proxy

## Overview

ANTHROPIC_BASE_URL 기반 로컬 프록시 서버. Claude Code의 모든 API 트래픽을 관찰하고, 조건부로 Codex(GPT-5.4)로 라우팅한다.

## System Diagram

```
User ↔ Claude Code ↔ localhost:8080 (Proxy) ↔ Anthropic API (default)
                                              ↔ OpenAI API (conditional)
```

## Core Principles

1. **Body 무수정 (Pass-through first)**: Request body를 절대 수정하지 않음. Native Client Attestation(`cch` 해시)이 body 내부에 있으므로 수정 시 인증 실패.
2. **Anthropic 토큰 절약**: Agent Worker 요청을 Codex로 라우팅하여 Anthropic 토큰 소모를 줄인다. Agent Worker 비율만큼 절약 (목표: 40%+ 감소). Max 구독 rate limit 여유 확보 → 529 에러 빈도 감소.
3. **Graceful degradation**: 프록시 장애 시 `ANTHROPIC_BASE_URL` 제거하면 원래대로 동작.
4. **로컬 전용**: 외부 전송 없음. 모든 데이터는 로컬 디스크에만 저장.
5. **Clean-room 포지셔닝**: 내부 소스 분석 유래 표현 금지. 트래픽 관찰 기반 역추론으로만 문서화.

## Request Classification

프록시는 `metadata.user_id` JSON 내 `querySource` 필드로 요청 유형을 자동 분류:

| querySource | 의미 | 라우팅 |
|---|---|---|
| `repl_main_thread` | 사용자 직접 대화 | Anthropic (변경 없음) |
| `agent:custom` | Agent 서브에이전트 | Phase 2에서 Codex 라우팅 대상 |
| `agent:default` | 기본 에이전트 | Phase 2에서 Codex 라우팅 대상 |
| `compact` | 백그라운드 압축 | Anthropic (변경 없음) |
| `verification_agent` | 검증 에이전트 | Anthropic (변경 없음) |

## Request Deduplication

`x-client-request-id` 헤더로 재시도 감지:
- 같은 ID 반복 = 재시도 (529 에러 후)
- 같은 ID + stream=false = 스트리밍 폴백

## Tech Stack

- Runtime: Node.js 18+
- HTTP: native `http` module (의존성 최소화)
- Streaming: SSE pass-through (Anthropic), SSE→변환 (OpenAI, Phase 2)
- Storage: JSONL 로그 파일
- Config: `.proxy.config.json` (라우팅 규칙, 로그 설정)

## Security

- localhost 바인딩만 (외부 접근 차단)
- API 키를 로그에 마스킹
- 로그 파일 자동 rotation (7일)
