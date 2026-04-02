# Metrics Spec: Observable Metrics

## Per-Turn Metrics

| Metric | Source | Description |
|--------|--------|-------------|
| `input_tokens` | response `usage.input_tokens` | 입력 토큰 수 |
| `output_tokens` | response `usage.output_tokens` | 출력 토큰 수 |
| `cache_write` | response `usage.cache_creation_input_tokens` | 캐시 쓰기 토큰 |
| `cache_read` | response `usage.cache_read_input_tokens` | 캐시 읽기 토큰 |
| `cache_hit_rate` | computed | `cache_read / (cache_read + input_tokens)` |
| `latency_ms` | measured | 첫 바이트까지 시간 (TTFB) |
| `total_duration_ms` | measured | 전체 스트리밍 완료 시간 |
| `model` | request body `model` | 사용 모델 |
| `query_source` | request body `metadata.user_id` | 요청 유형 |
| `tool_count` | request body `tools.length` | 전송된 도구 수 |
| `message_count` | request body `messages.length` | 대화 히스토리 턴 수 |
| `is_retry` | `x-client-request-id` 중복 감지 | 재시도 여부 |
| `speed` | request body `speed` | fast mode 여부 |
| `thinking_enabled` | request body `thinking` | thinking 활성 여부 |

## Session-Level Aggregates

| Metric | Description |
|--------|-------------|
| `total_input_tokens` | 세션 누적 입력 토큰 |
| `total_output_tokens` | 세션 누적 출력 토큰 |
| `avg_cache_hit_rate` | 세션 평균 캐시 히트율 |
| `retry_count` | 재시도 횟수 |
| `agent_request_ratio` | Agent 요청 비율 |
| `turns` | 총 턴 수 |
| `context_growth_rate` | 턴당 컨텍스트 증가율 (`logger.mjs`가 연속 턴의 `input_tokens` 차이로 계산) |

## Log Format

JSONL, one line per request-response pair:

```json
{
  "ts": "2026-04-02T16:30:00Z",
  "session_id": "X-Claude-Code-Session-Id value",
  "request_id": "x-client-request-id value",
  "query_source": "repl_main_thread",
  "model": "claude-opus-4-6",
  "input_tokens": 18432,
  "output_tokens": 2100,
  "cache_read": 15000,
  "cache_write": 3000,
  "cache_hit_rate": 0.81,
  "ttfb_ms": 1200,
  "duration_ms": 3400,
  "tool_count": 23,
  "message_count": 12,
  "is_retry": false,
  "speed": null,
  "thinking": true,
  "routed_to": "anthropic",
  "status": 200
}
```
