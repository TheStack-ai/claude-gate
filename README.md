# claude-gate

Local observability gateway for Claude Code — monitor, route, and optimize your API traffic

Author: DD (whynowlab)  
License: Apache 2.0

## Quick Start

`npm install -g claude-gate` → `claude-gate run` → done

## What It Does

You talk to Claude directly. Claude's background tasks (file search, compression, verification) get routed to Codex, saving your Claude quota without changing your experience.

## Features

- Traffic observation
- Live dashboard
- Smart routing (subagents + compact + verification)
- 529 fallback
- Session analytics
- Cost estimation

## Commands

- `claude-gate init` — create `~/.claude-gate/config.json`
- `claude-gate run` — start the gateway and launch Claude Code
- `claude-gate start` — start the gateway only
- `claude-gate stop` — stop the running gateway
- `claude-gate dashboard [--fresh] [--lang en|ko]` — open the live terminal dashboard
- `claude-gate stats` — show session metrics
- `claude-gate advise` — print routing and config suggestions from recorded traffic

## Configuration

Default config file: `~/.claude-gate/config.json`

```json
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
    "target_query_sources": ["agent:custom", "agent:default", "compact", "verification_agent"],
    "max_tool_count": 5,
    "thinking_enabled": false
  },
  "routing": {
    "enabled": false,
    "rules": []
  },
  "fallback_529": {
    "enabled": false,
    "target_query_sources": ["agent:custom", "agent:default", "compact", "verification_agent"]
  }
}
```

- `anthropic` — upstream Claude API endpoint and API key env var
- `openai` — OpenAI-compatible endpoint, API key env var, and default model used for routing and fallback
- `shadow` — observe selected background requests with Codex-compatible evaluation without changing the live Claude response
- `routing` — rules for actively sending selected background requests away from Anthropic
- `fallback_529` — retry selected background requests through the alternate route when Anthropic returns `529`

Run `claude-gate init` to generate a starter config.

## Dashboard

[screenshot]

## Requirements

- Node.js `>=18`
- Zero external dependencies
- Optional Codex CLI for routing features

## How It Works

```text
You
 |
 v
Claude Code
 |
 v
+----------------------+
|     claude-gate      |
|                      |
| direct requests  ------------------> Anthropic API
| background tasks ------------------> Codex
+----------------------+
```

Direct conversation turns stay on Claude. Background work such as subagents, compact passes, and verification can be observed or rerouted.

## Disclaimer

This is NOT an official Anthropic product. claude-gate is an independent open-source tool.

## License

Apache 2.0
