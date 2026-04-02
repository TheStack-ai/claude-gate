# Codex Integration Spec

## Overview

Codex(GPT-5.4)를 프록시를 통해 Claude Code 세션에 투명하게 통합한다. 두 가지 모드: Shadow Evaluation, Active Routing.

## Shadow Evaluation (Phase 1)

Claude API 응답과 별개로, 같은 요청을 Codex에 비동기 전송하여 결과를 비교한다.

### Flow

```
1. Claude Code → Proxy → Anthropic API → Response (정상 반환)
2.                Proxy → (async) Format Convert → OpenAI API → Shadow Response
3.                Proxy → Compare(Response, Shadow) → Log divergence
```

### 대상 요청

- `querySource: agent:*` 요청만 (메인 대화는 shadow 안 함)
- `tools.length <= 5` (단순 Worker만)
- thinking이 비활성인 요청만

### Format Conversion (Anthropic → OpenAI)

```
Anthropic Request:
  model → gpt-5.4
  messages[].role: user/assistant → 동일
  messages[].content: [{type: "text", text: "..."}] → "..." (string)
  messages[].content: [{type: "tool_use", ...}] → tool_calls format
  messages[].content: [{type: "tool_result", ...}] → tool role message
  system → messages[0] with role: "system"
  tools[].input_schema → tools[].function.parameters
```

### Divergence Detection

```json
{
  "divergence_type": "tool_choice" | "output_content" | "error",
  "anthropic_tool": "Edit",
  "codex_tool": "Edit",
  "similarity_score": 0.85,
  "details": "different file path suggested"
}
```

divergence_score < 0.7 이면 로그에 WARNING 플래그.

## Active Routing (Phase 2)

특정 조건의 Agent Worker 요청을 Codex로 실제 라우팅하여 응답을 대체한다.

### Routing Rules

```json
{
  "rules": [
    {
      "name": "agent-worker-to-codex",
      "condition": {
        "query_source": ["agent:custom", "agent:default"],
        "tool_count_max": 3,
        "thinking_enabled": false
      },
      "target": "openai",
      "model": "gpt-5.4",
      "enabled": false
    }
  ]
}
```

### Format Conversion (OpenAI Response → Anthropic)

```
OpenAI Response:
  choices[0].message.content → content[{type: "text", text: "..."}]
  choices[0].message.tool_calls → content[{type: "tool_use", id, name, input}]
  usage.prompt_tokens → usage.input_tokens
  usage.completion_tokens → usage.output_tokens
  finish_reason: "stop" → stop_reason: "end_turn"
  finish_reason: "tool_calls" → stop_reason: "tool_use"
```

### Streaming Conversion (OpenAI SSE → Anthropic SSE)

```
OpenAI: data: {"choices":[{"delta":{"content":"..."}}]}
→
Anthropic: event: content_block_delta
           data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"..."}}
```

Required events sequence:
1. `message_start` (synthetic)
2. `content_block_start` (per block)
3. `content_block_delta` (streaming content)
4. `content_block_stop`
5. `message_delta` (stop_reason, usage)
6. `message_stop`

## 529 Fallback (Phase 2)

```
1. Claude Code → Proxy → Anthropic API → 529 Error
2. Proxy: 재시도 대신 → Format Convert → OpenAI API → Response
3. Proxy → Format Convert (OpenAI → Anthropic) → Claude Code
```

조건:
- `querySource: agent:*` 요청만 (메인 대화는 폴백 안 함)
- 스트리밍 시작 전 529만 (부분 스트리밍 중 폴백 금지)
- 폴백 발생 시 로그에 기록

## Configuration

```json
// .proxy.config.json
{
  "anthropic": {
    "base_url": "https://api.anthropic.com",
    "api_key_env": "ANTHROPIC_API_KEY"
  },
  "openai": {
    "base_url": "https://api.openai.com/v1",
    "api_key_env": "OPENAI_API_KEY",
    "default_model": "gpt-5.4"
  },
  "shadow": {
    "enabled": true,
    "target_query_sources": ["agent:custom", "agent:default"],
    "max_tool_count": 5,
    "thinking_enabled": false
  },
  "routing": {
    "enabled": false,
    "rules": []
  },
  "fallback_529": {
    "enabled": false,
    "target_query_sources": ["agent:custom", "agent:default"]
  }
}
```
