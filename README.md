# cc-mux

Resilience and observability gateway for Claude Code — recover from 529 overloads, monitor API traffic, and optionally route tool-continuation turns to Codex.

## Quick Start

```bash
npm install -g cc-mux
cc-mux init        # detect Codex CLI, create config
cc-mux run         # start gateway + Claude Code
```

## What It Does

**Out of the box (no Codex needed):**
- Monitor all Claude Code API traffic in real time
- Live dashboard with token usage, latency, cost estimates
- Session analytics and optimization recommendations

**With Codex CLI installed:**
- 529 overload recovery — when Claude is overloaded, Codex handles the request
- Tool-continuation routing (opt-in) — route mechanical tool-chaining turns to Codex

## How Routing Works

```text
You → Claude Code → cc-mux
                       │
           ┌───────────┼───────────┐
           │                       │
   User messages              Tool continuations
   (thinking, planning)       (Read, Grep, Edit chains)
           │                       │
           ▼                       ▼
     Anthropic API            Codex CLI
      (Claude)               (GPT-5.4)
```

When Claude reads a file and decides to read another, that second call is a **tool continuation**. cc-mux can route these to Codex. This is **opt-in** — disabled by default.

- Error tool results are never routed (Claude handles failures)
- User-initiated turns always go to Claude
- 529 fallback works for any request type

## Commands

| Command | Description |
|---------|-------------|
| `cc-mux init` | Create config at `~/.cc-mux/config.json` |
| `cc-mux run` | Start gateway + launch Claude Code |
| `cc-mux start` | Start gateway only |
| `cc-mux stop` | Stop running gateway |
| `cc-mux dashboard` | Live terminal dashboard |
| `cc-mux stats` | Session metrics |
| `cc-mux advise` | Optimization recommendations |

Options: `--port 8080` `--config <path>` `--lang en|ko` `--fresh`

## Configuration

`cc-mux init` generates a config. To enable Codex routing, edit `~/.cc-mux/config.json`:

```json
{
  "routing": {
    "enabled": true,
    "rules": [
      {
        "name": "tool-continuation-to-codex",
        "enabled": true,
        "target": "openai",
        "model": "gpt-5.4",
        "condition": {
          "last_message_tool_result": true
        }
      }
    ]
  },
  "fallback_529": {
    "enabled": true,
    "target_query_sources": []
  }
}
```

### Trade-offs

- Codex routing reduces Claude API usage but adds latency (Codex CLI is slower)
- 529 fallback has no quality trade-off — it only activates when Claude is unavailable
- Cost estimates in the dashboard are approximate (model-specific pricing applied)

## Requirements

- Node.js ≥18
- Zero external dependencies
- [Codex CLI](https://github.com/openai/codex) for routing/fallback features (optional)
- [oh-my-codex](https://github.com/mcp-use/oh-my-codex) supported — auto-detected when installed

## Disclaimer

This is NOT an official Anthropic or OpenAI product. cc-mux is an independent open-source tool. Use at your own discretion.

## License

MIT
