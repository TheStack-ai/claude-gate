# claude-proxy

ANTHROPIC_BASE_URL 기반 로컬 프록시. Claude Code API 트래픽 관찰 + Codex(GPT-5.4) 자동 통합.

## 배경

Claude Code 소스 분석(~/preservation/analysis-20260402/)에서 발견한 내부 구조를 기반으로 설계.
핵심 발견: `metadata.user_id` JSON 내 `querySource` 필드로 요청 유형 자동 분류 가능.

## 스펙

모든 설계는 OpenSpec에 정의됨. 구현 전 반드시 읽을 것:

```
openspec/specs/
  architecture.md          — 전체 아키텍처, body 무수정 원칙, 보안
  metrics.md               — 관찰 메트릭 정의, JSONL 로그 포맷
  codex-integration.md     — Shadow eval + 라우팅 + 폴백 + 포맷 변환 상세
  phases.md                — Phase 1-3 로드맵, artifact 목록, 성공 기준
  strategy-constraints.md  — 전략팀 Go/No-Go, 리스크, 법적 포지셔닝
```

## 구현 규칙

1. **단독 코딩 금지** — 반드시 `/codex:rescue`로 구현 위임 또는 `dispatch-team.sh implement/ai-engineer` 팀 협업
2. **Body 무수정** — Request body를 절대 수정하지 않음. Native Client Attestation(`cch` 해시)이 body 내부에 있음
3. **Clean-room 원칙** — 코드/문서에 "소스 분석", "preservation", "내부 구조" 등 유래 표현 금지. "트래픽 관찰 기반"으로만 표현
4. **OpenSpec 기반** — 구현 전 `openspec show <phase>` 확인, 완료 후 `openspec archive`

## 현재 Phase

**Phase 1: Observe + Shadow Evaluation** (change: phase-1-observe-shadow)

```
openspec show phase-1-observe-shadow --type change
```

Artifacts:
- src/proxy.mjs — HTTP 패스스루 프록시
- src/logger.mjs — JSONL 메트릭 로거
- src/classifier.mjs — querySource 파서
- src/shadow.mjs — Codex shadow evaluation
- src/format.mjs — Anthropic→OpenAI 변환 (shadow용)
- .proxy.config.json — 설정
- bin/claude-proxy — CLI

## 기술 결정 사항

- Runtime: Node.js 18+ (의존성 최소화)
- Streaming: SSE pass-through
- Storage: JSONL
- Attestation: body 무수정 패스스루 → 통과 확인 완료 (테스트: /tmp/attestation-test/proxy.mjs)
- GrowthBook 직접 관찰 불가 (효과 역추론만 가능)
- LiteLLM 참조 가능하나 Phase 1은 독자 구현

## 참조

- 전략팀 결과: ~/.claude/orchestrator/state/agent-outputs/structured/strategy-2026-04-02.json
- 소스 분석: ~/preservation/analysis-20260402/ (07-STRATEGIC-INSIGHTS.md 특히)
- Attestation 테스트: /tmp/attestation-test/proxy.mjs
