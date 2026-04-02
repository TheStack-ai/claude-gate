# Strategy Constraints Spec

## 전략팀 검토 결과 (2026-04-02)

Verdict: **CONDITIONAL GO**

## Go Conditions

1. Native Client Attestation 스파이크 통과 → **통과 완료** (body 무수정 패스스루 정상 동작)
2. MVP를 로컬 전용 도구로 제한 → Phase 1 scope에 반영
3. Shadow mode 중심 출시 → Phase 1에서 shadow eval만
4. Clean-room 원칙 유지 → architecture.md에 명시

## No-Go Conditions (모니터링)

1. Attestation으로 핵심 기능 차단 → 현재 해당 없음
2. 자동 라우팅 품질 불안정 → Phase 1 shadow eval 데이터로 판단
3. ToS 위반 가능성 → clean-room 포지셔닝으로 회피

## Risk Mitigations

| Risk | Mitigation | Status |
|------|-----------|--------|
| Native Client Attestation | body 무수정 원칙 | ✅ 검증 완료 |
| Anthropic 내부 구조 변경 | 내부 필드 의존 기능 optional 분리, pass-through 우선 | 설계에 반영 |
| 529 폴백 race condition | 스트리밍 시작 전 529만 폴백, 부분 스트리밍 중 금지 | Phase 2에서 구현 |
| MITM 우려 | 로컬 전용, 저장 기본 off 옵션, 원격 전송 없음 | architecture.md에 명시 |

## Legal Positioning

- 공개 시 "Claude Code 해킹 프록시"가 아니라 **"로컬 LLM API observability tool"**로 포지셔닝
- README/문서/코드에서 내부 소스 분석 유래 표현 제거
- 모든 기능은 "트래픽 관찰 기반 역추론"으로 문서화
- 법률 검토 전 SaaS/유료화 보류

## Technical Constraints

- LiteLLM 기반 MVP 검토 (독자 구현 91시간 vs LiteLLM 기반 25시간) → 최종 판단: Phase 1은 독자 구현 (의존성 최소화), Phase 2에서 LiteLLM 스트리밍 변환 참조
- GrowthBook 플래그 직접 관찰 불가 (암호화/원격 평가) → 효과 역추론만 가능 → scope에서 제외
