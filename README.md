# LongerAgent

**Multi-agent CLI with proactive context management.**

LongerAgent is a terminal-based AI agent that keeps a structured session log as its source of truth. The TUI and provider input are both projections of that same log, which lets long sessions survive summarization, compacting, retries, and resume without drifting into separate state models.

## What makes LongerAgent different?

Most AI agents hit a wall when conversations get long: the context window fills up, and the agent either loses important details or crashes. LongerAgent addresses that with three built-in mechanisms:

1. **Hint Compression** — When context usage rises, the system nudges the agent to summarize older consumed context
2. **Agent-Initiated Summarization** — The `summarize_context` tool lets the agent compress contiguous context segments into summaries
3. **Auto-Compact** — Near the context limit, the system performs a full context reset with a continuation context and archive window

These mechanisms operate on the same structured log used for rendering and resume, so the runtime keeps one coherent model of the session.

## Quick Start

```bash
# Install globally
npm install -g longer-agent

# Run the setup wizard (creates ~/.longeragent/config.yaml)
longeragent init

# Start LongerAgent
longeragent
```

## Supported Providers

| Provider | Models | Env Variable |
|----------|--------|-------------|
| **Anthropic** | Claude Opus 4.6, Claude Sonnet 4.6 | `ANTHROPIC_API_KEY` |
| **OpenAI** | GPT-5, GPT-5.1, GPT-4o | `OPENAI_API_KEY` |
| **Kimi / Moonshot** | Kimi K2.5, K2 Instruct | `KIMI_API_KEY` |
| **MiniMax** | MiniMax M2.5, M2 | `MINIMAX_API_KEY` |
| **GLM / Zhipu** | GLM-5, GLM-4.7 | `GLM_API_KEY` |
| **OpenRouter** | Any model via OpenRouter | `OPENROUTER_API_KEY` |

## Key Features

- **`/model`** — Switch between configured models at runtime
- **`/thinking`** — Control thinking/reasoning depth per model
- **`/resume`** — Resume previous sessions from `log.json`
- **Sub-agents** — Spawn and coordinate sub-agents for parallel work
- **MCP Integration** — Connect to Model Context Protocol servers for additional tools
- **Skills System** — Load reusable skill instructions and expose them as a dynamic `skill` tool
- **Session Persistence** — Persist active logs and archive compacted windows
- **11 Built-in Tools** — `read_file`, `list_dir`, `glob`, `grep`, `edit_file`, `write_file`, `bash`, `diff`, `test`, `web_search`, `web_fetch`

## Configuration

LongerAgent stores its configuration in `~/.longeragent/`:

```text
~/.longeragent/
├── config.yaml          # Model configurations and settings
├── agent_templates/     # Agent definitions (main, explorer, etc.)
│   ├── main/
│   │   ├── agent.yaml
│   │   └── system_prompt.md
│   └── explorer/
│       ├── agent.yaml
│       └── system_prompt.md
└── skills/              # Reusable skill definitions
    └── explain-code/
        └── SKILL.md
```

See [configExample.yaml](./configExample.yaml) for a comprehensive configuration reference.

## Architecture

LongerAgent is built around a pipeline: **Session -> Agent -> Provider**.

- **Session** orchestrates the turn loop, message delivery, summarization, compacting, and sub-agent lifecycle
- **Session Log** is the single source of truth; TUI and provider input are projections of the same structured log
- **Agent** wraps a model + system prompt + tools into a reusable execution unit
- **Provider** adapters normalize streaming, reasoning, tool calls, usage, and provider-specific request formats

For a detailed architecture map, see [Docs/MAP.md](./Docs/MAP.md).

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
# Install dependencies
pnpm install

# Development mode (auto-reload)
pnpm dev

# Build
pnpm build

# Run tests
pnpm test

# Type check
pnpm typecheck
```

## License

[MIT](./LICENSE)
