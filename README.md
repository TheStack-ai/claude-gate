# cc-mux

Local gateway for Claude Code — automatically route tool-continuation turns to Codex, saving your Claude quota without changing your experience.

## Quick Start

```bash
npm install -g cc-mux
cc-mux init        # detect Codex CLI, create config
cc-mux run         # start gateway + Claude Code
```

## How It Works

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

When Claude reads a file and decides to read another file, that second call is a **tool continuation** — the last message is a `tool_result`, and the model just needs to pick the next tool. These mechanical loops make up 50-80% of API calls. cc-mux routes them to Codex automatically.

- **User-initiated turns** → always Claude (thinking, reasoning, judgment)
- **Tool-continuation turns** → Codex (file reads, greps, edits in a chain)
- **529 overload** → Codex fallback for any request

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

## Dashboard

The live dashboard shows Claude vs Codex routing in real time:

- Routing split (Claude/Codex request counts and ratio)
- Estimated savings (what Codex-handled turns would have cost on Claude)
- 529 recovery count
- Recent API calls with routing indicator

```bash
cc-mux dashboard --lang ko
```

## Configuration

`cc-mux init` auto-detects Codex CLI and generates optimal defaults.

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

### Routing conditions

| Condition | Description |
|-----------|-------------|
| `last_message_tool_result` | Last message contains tool_result blocks |
| `thinking_enabled` | Extended thinking is active |
| `tool_count_max` | Maximum number of tools in request |
| `query_source` | Request type filter (if available) |

## Requirements

- Node.js ≥18
- Zero external dependencies
- [Codex CLI](https://github.com/openai/codex) for routing features (optional — gateway works as observer without it)

## Disclaimer

This is NOT an official Anthropic product. cc-mux is an independent open-source tool that observes API traffic to provide routing and analytics.

## License

MIT

Author: DD (whynowlab)
