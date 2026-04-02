# Change: Phase 3 — Optimize + Distribute

## Summary

Phase 1-2 실사용 데이터를 기반으로 최적화 권고 엔진을 구축하고, clean-room 원칙으로 오픈소스 배포한다.

## Motivation

- 2주+ 실사용 데이터에서 패턴 추출 → 자동화된 최적화 권고
- 재시도 응답 캐싱으로 529 시 토큰 낭비 제거
- 다른 Claude Code 파워유저에게도 유용한 도구로 배포

## Prerequisite

- Phase 2 완료
- 2주 이상 실사용 데이터 축적

## Affected Specs

- [phases](../../specs/phases.md) — Phase 3
- [strategy-constraints](../../specs/strategy-constraints.md) — Legal Positioning

## Artifacts

| File | Description | Status |
|------|-------------|--------|
| `src/cache.mjs` | 재시도 응답 캐시 | TODO |
| `src/advisor.mjs` | 최적화 권고 엔진 | TODO |
| `README.md` | 공개용 문서 (clean-room) | TODO |
| `LICENSE` | Apache-2.0 또는 MIT | TODO |
| `package.json` | npm 배포 설정 | TODO |

## Advisor Rules (예시)

```
Rule 1: 캐시 히트율 < 50% → "CLAUDE.md 동적 섹션 크기 확인 권장"
Rule 2: Agent Worker 비율 > 40% → "Codex 라우팅 활성화 시 Anthropic 부하 절반"
Rule 3: 재시도 횟수 > 세션당 3회 → "529 폴백 활성화 권장"
Rule 4: 컨텍스트 증가율 > 10K/턴 → "compaction 타이밍 조기화 검토"
Rule 5: Fast mode 활성 턴 > 50% → "Fast mode 6배 과금 주의"
```

## Acceptance Criteria

1. `npm install -g claude-proxy`로 설치 가능
2. README에 내부 소스 분석 유래 표현 없음
3. `claude-proxy advise`가 실행 가능한 권고 3개 이상 제공
4. 재시도 캐싱으로 529 시 추가 API 호출 0
5. Apache-2.0 또는 MIT 라이센스
6. GitHub Actions CI (lint, test)
