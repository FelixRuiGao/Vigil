# LongerAgent

**Multi-agent CLI with proactive context management.**

LongerAgent is a terminal-based AI coding agent built around a structured session log. The log is the single source of truth — the TUI display and provider input are both projections of the same data, which means long sessions survive summarization, compaction, and resume without state drift.

## Highlights

### Proactive Context Management

Most agents crash or silently lose information when conversations get long. LongerAgent has a three-layer system that keeps context under control:

1. **Hint Compression** — As context grows, the system prompts the agent to summarize older segments
2. **Agent-Initiated Summarization** — The agent uses `show_context` to inspect its context distribution and `summarize_context` to compress selected segments into dense summaries, preserving key decisions, file paths, and unresolved issues
3. **Auto-Compact** — Near the context limit, the system performs a full context reset with a continuation summary and archive window

Thresholds for all three layers are configurable via `settings.json`.

### Multi-Agent Coordination

Spawn sub-agents from YAML call files for parallel work. Three built-in templates:

- **main** — Full-capability agent with all 23 tools
- **explorer** — Read-only agent for codebase exploration
- **executor** — Task-focused agent with basic tools, no orchestration overhead

Sub-agents run concurrently. The main agent tracks their progress via `check_status` / `wait` and receives structured reports when they complete.

### Message Delivery During Work

You can type messages to the agent at any time — even while it's working. Messages are queued and delivered at activation boundaries or when the agent calls `check_status` / `wait`. The agent receives a notification summary so it knows when new input is available.

## Quick Start

```bash
# Install globally
npm install -g longer-agent

# Run the setup wizard (creates ~/.longeragent/config.yaml and empty override dirs)
longeragent init

# Start LongerAgent
longeragent
```

## Supported Providers

| Provider | Models | Env Variable |
|----------|--------|-------------|
| **Anthropic** | Claude Haiku 4.5, Opus 4.6, Sonnet 4.6 (+ 1M context beta variants) | `ANTHROPIC_API_KEY` |
| **OpenAI** | GPT-5.2, GPT-5.2 Codex, GPT-5.3 Codex, GPT-5.4 | `OPENAI_API_KEY` |
| **Kimi / Moonshot (China)** | Kimi K2.5, K2 Instruct | `KIMI_CN_API_KEY` |
| **Kimi / Moonshot (Global)** | Kimi K2.5, K2 Instruct | `KIMI_API_KEY` |
| **MiniMax** | M2.1, M2.5 | `MINIMAX_API_KEY` |
| **GLM / Zhipu** | GLM-5, GLM-4.7 | `GLM_API_KEY` |
| **OpenRouter** | Curated presets for Claude, GPT, Kimi, MiniMax, GLM, plus any custom model | `OPENROUTER_API_KEY` |

## Tools

**15 built-in tools:**

`read_file` · `list_dir` · `glob` · `grep` · `edit_file` · `write_file` · `apply_patch` · `bash` · `bash_background` · `bash_output` · `kill_shell` · `diff` · `test` · `web_search` · `web_fetch`

**8 orchestration tools:**

`spawn_agent` · `kill_agent` · `check_status` · `wait` · `show_context` · `summarize_context` · `ask` · `plan`

**+ Skills system** — Load reusable skill definitions as a dynamic `skill` tool.

**+ MCP Integration** — Connect to Model Context Protocol servers for additional tools.

## Slash Commands

| Command | Description |
|---------|-------------|
| `/model` | Switch between configured models at runtime |
| `/thinking` | Control thinking/reasoning depth per model |
| `/resume` | Resume a previous session from its log |
| `/compact` | Manually trigger context compaction |

## Configuration

LongerAgent loads bundled defaults from the installed package (`agent_templates/`, `prompts/`, `skills/`) and user overrides from `~/.longeragent/`.
`longeragent init` creates `config.yaml` plus empty `agent_templates/` and `skills/` override directories.

```text
~/.longeragent/
├── config.yaml            # Model and provider configurations (created by init)
├── settings.json          # Runtime tuning (optional, user-managed)
├── tui-preferences.json   # Auto-saved TUI state
├── agent_templates/       # Optional user template overrides (empty by default)
├── skills/                # Optional user skills (empty by default)
└── prompts/               # Optional user prompt overrides (create manually if needed)
```

See [configExample.yaml](./configExample.yaml) for a configuration reference.

### Runtime Settings (`settings.json`)

Manually edit `~/.longeragent/settings.json` to tune runtime behavior:

```jsonc
{
  // Override max output tokens (clamped to [4096, model max])
  "max_output_tokens": 32000,
  // Context management thresholds (percentage of effective context, 20-95)
  "context": {
    "summarize_hint_level1": 60,
    "summarize_hint_level2": 80,
    "compact_output": 85,
    "compact_toolcall": 90
  }
}
```

## Architecture

LongerAgent is built around a **Session → Agent → Provider** pipeline:

- **Session** orchestrates the turn loop, message delivery, summarization, compaction, and sub-agent lifecycle
- **Session Log** is the single source of truth — 20 entry types capture every runtime event
- **Agent** wraps a model + system prompt + tools into a reusable execution unit
- **Provider** adapters normalize streaming, reasoning, tool calls, and usage across 6 provider families

## CLI Options

```text
longeragent                     # Start with auto-detected config
longeragent init                # Run setup wizard
longeragent --config <path>     # Use a specific config file
longeragent --templates <path>  # Use a specific templates directory
longeragent --verbose           # Enable debug logging
```

## Development

```bash
pnpm install        # Install dependencies
pnpm dev            # Development mode (auto-reload)
pnpm build          # Build
pnpm test           # Run tests (vitest)
pnpm typecheck      # Type check
```

## License

[MIT](./LICENSE)
