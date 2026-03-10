<p align="center">
  <img src="https://raw.githubusercontent.com/FelixRuiGao/LongerAgent/main/assets/logo.png" alt="LongerAgent" width="360" />
</p>
<p align="center">
  <strong>A terminal AI coding agent built for long sessions.</strong>
</p>
<p align="center">
  English | <a href="./README.zh-CN.md">中文</a>
</p>
<p align="center">
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-blue?style=flat-square&logo=typescript&logoColor=white" />
  <img alt="Author" src="https://img.shields.io/badge/author-Felix%20Rui%20Gao-4b4bf0?style=flat-square" />
</p>

Most AI agents crash, loop, or silently lose context when conversations get long. LongerAgent is built from the ground up for sessions that last longer — with a structured log architecture, three-layer context management, and persistent memory that survives across sessions.

![LongerAgent Terminal UI](https://raw.githubusercontent.com/FelixRuiGao/LongerAgent/main/assets/screenshot.png)

https://github.com/user-attachments/assets/de1f4bc5-7f94-4226-a3cc-9a74bed69f1b

> **Platform:** macOS. Windows is not tested.
>
> **Security:** LongerAgent does not sandbox commands or require approval before file edits and shell execution. Use it in trusted environments and review what it does.

## Quick Start

```bash
# Install globally
npm install -g longer-agent

# Run the setup wizard (creates ~/.longeragent/config.yaml)
longeragent init

# Start
longeragent
```

---

## Highlights

- **Three-layer context management** — sessions that last longer and longer
- **Parallel sub-agents** — spawn workers for concurrent tasks from YAML call files
- **Skills system** — install, manage, and create reusable skill packages by itself
- **Persistent memory** — `AGENTS.md` files and Important Log survive across sessions and compactions
- **Async messaging** — talk to the agent while it's mid-task
- **7 provider families** — Anthropic, OpenAI, Kimi, MiniMax, GLM, OpenRouter, and any OpenRouter-compatible model

## Usage

### Context Management

The agent manages its own context automatically, but you can also intervene:

```text
/summarize                                # Summarize older context segments
/summarize Keep the auth refactor details # Summarize with specific instructions
/compact                                  # Full context reset with continuation summary
/compact Preserve the DB schema decisions # Compact with specific instructions
```

`/summarize` surgically compresses selected segments while preserving key decisions — use it when context is growing but you're not ready for a full reset. `/compact` is the nuclear option: full reset with a continuation summary so the agent picks up where it left off.

The agent can also do both on its own via `show_context` and `summarize_context` tools — no user action needed.

An **Important Log** is maintained throughout the session — key discoveries, failed approaches, and architectural decisions are written here and survive every compaction.

### Sub-Agents

Tell the agent to spawn sub-agents, or define tasks in a YAML call file:

```yaml
# tasks.yaml
tasks:
  - name: research
    template: explorer
    prompt: "Investigate how authentication works in this codebase"
  - name: refactor
    template: executor
    prompt: "Rename all legacy API endpoints to v2"
```

Three built-in templates: **main** (full tools), **explorer** (read-only), **executor** (task-focused). Sub-agents run concurrently and report back when done.

### Skills

Skills are reusable tool definitions the agent can load on demand.

```text
You:   "Install skill: apple-notes"        # Agent uses built-in skill-manager
You:   /skills                              # Toggle skills on/off with a picker
```

Create your own by adding a `SKILL.md` to `~/.longeragent/skills/<name>/`.

### Persistent Memory

Two `AGENTS.md` files are loaded on every turn:

- **`~/AGENTS.md`** — Global preferences across all projects
- **`<project>/AGENTS.md`** — Project-specific patterns and architecture notes

The agent reads them for context and can write to them to save long-term knowledge. These persist across sessions and context resets.

### Async Messaging

Type messages at any time — even while the agent is working. Messages are queued and delivered at the next activation boundary.

<details>
<summary><strong>How context management works (details)</strong></summary>

Three layers work together to keep context under control:

1. **Hint Compression** — As context grows, the system prompts the agent to proactively summarize older segments
2. **Agent-Initiated Summarization** — The agent inspects its own context distribution via `show_context` and surgically compresses selected segments with `summarize_context`, preserving key decisions and unresolved issues
3. **Auto-Compact** — Near the limit, the system performs a full context reset with a continuation summary — the agent picks up exactly where it left off

</details>

## Supported Providers

| Provider | Models | Env Variable |
|----------|--------|-------------|
| **Anthropic** | Claude Haiku 4.5, Opus 4.6, Sonnet 4.6 (+ 1M context variants) | `ANTHROPIC_API_KEY` |
| **OpenAI** | GPT-5.2, GPT-5.2 Codex, GPT-5.3 Codex, GPT-5.4 | `OPENAI_API_KEY` or OAuth |
| **Kimi / Moonshot** | Kimi K2.5, K2 Instruct (Global, China, Coding Plan) | `KIMI_CN_API_KEY` / `KIMI_API_KEY` |
| **MiniMax** | M2.1, M2.5 (Global, China) | `MINIMAX_API_KEY` |
| **GLM / Zhipu** | GLM-5, GLM-4.7 (Global, China, Coding Plan) | `GLM_API_KEY` |
| **OpenRouter** | Curated presets for Claude, GPT, Kimi, MiniMax, GLM, plus any custom model | `OPENROUTER_API_KEY` |

## Tools

**15 built-in tools:**

`read_file` · `list_dir` · `glob` · `grep` · `edit_file` · `write_file` · `apply_patch` · `bash` · `bash_background` · `bash_output` · `kill_shell` · `diff` · `test` · `web_search` · `web_fetch`

`read_file` supports image files (PNG, JPG, GIF, WebP, etc.) on multimodal models — the agent can directly see and analyze images.

**8 orchestration tools:**

`spawn_agent` · `kill_agent` · `check_status` · `wait` · `show_context` · `summarize_context` · `ask` · `plan`

**Skills system** — Load reusable skill definitions as a dynamic `skill` tool. Manage with `/skills` (checkbox picker for enable/disable), hot-reload with `reload_skills`. Includes a built-in `skill-manager` that teaches the agent to search, download, and install new skills autonomously.

**MCP Integration** — Connect to Model Context Protocol servers for additional tools.

## Slash Commands

| Command | Description |
|---------|-------------|
| `/model` | Switch between configured models at runtime |
| `/thinking` | Control thinking/reasoning depth per model |
| `/skills` | Enable/disable skills with a checkbox picker |
| `/resume` | Resume a previous session from its log |
| `/summarize` | Summarize older context segments to free up space |
| `/compact` | Full context reset with a continuation summary |

## Configuration

LongerAgent loads bundled defaults from the installed package and user overrides from `~/.longeragent/`.
`longeragent init` creates `config.yaml` plus empty override directories.

```text
~/.longeragent/
├── config.yaml            # Model and provider configurations (created by init)
├── settings.json          # Runtime tuning (optional)
├── tui-preferences.json   # Auto-saved TUI state
├── agent_templates/       # User template overrides
├── skills/                # User skills
└── prompts/               # User prompt overrides
```

See [configExample.yaml](./configExample.yaml) for a configuration reference.

### Runtime Settings (`settings.json`)

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
- **Session Log** is the single source of truth — 20+ entry types capture every runtime event; the TUI display and provider input are both projections of the same data
- **Agent** wraps a model + system prompt + tools into a reusable execution unit
- **Provider** adapters normalize streaming, reasoning, tool calls, and usage across 7 provider families

## CLI Options

```text
longeragent                     # Start with auto-detected config
longeragent init                # Run setup wizard
longeragent oauth               # Log in to OpenAI via OAuth (device code / browser)
longeragent oauth status        # Check OAuth login status
longeragent oauth logout        # Log out
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
