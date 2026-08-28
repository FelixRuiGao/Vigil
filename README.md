

# Fermi

<p align="center">
  <strong>The coding agent that manages its own contexts.</strong>
</p>
<p align="center">
  Terminal UI built on <a href="https://github.com/anomalyco/opentui">OpenTUI</a>.
</p>
<p align="center">
  English | <a href="./README.zh-CN.md">中文</a>
</p>
<p align="center">
  <a href="https://github.com/FelixRuiGao/Fermi/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/FelixRuiGao/Fermi?style=flat-square" /></a>
  <a href="https://felixruigao.github.io/Fermi/"><img alt="Docs" src="https://img.shields.io/badge/docs-website-4b4bf0?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/opentui"><img alt="OpenTUI" src="https://img.shields.io/badge/built%20on-OpenTUI-7c3aed?style=flat-square" /></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
</p>

![Fermi — sub-agent spawning, build verification, and live context stats](assets/session.png)

Fermi is a terminal AI coding agent designed for multi-hour sessions. The agent inspects its own context window, decides what is still valuable, and surgically compresses the rest — down to a single tool call result. Sessions run for hours; decisions, file paths, and unresolved issues stay intact.

> **Platform:** macOS (Apple Silicon) · Linux (x86_64, arm64) · Windows (x64, arm64). **License:** MIT.

## Install

### macOS (Apple Silicon) / Linux (x86_64, arm64)

```bash
curl -fsSL https://raw.githubusercontent.com/FelixRuiGao/Fermi/main/scripts/install.sh | sh
```

### Windows (x64, arm64)

```powershell
irm https://raw.githubusercontent.com/FelixRuiGao/Fermi/main/scripts/install.ps1 | iex
```

---

Single binary, no runtime required. The installer puts `fermi` (`fermi.exe` on Windows) in `~/.fermi/bin/` and adds it to your PATH. Open a new terminal, then:

```bash
fermi init   # setup wizard — pick providers, models, API keys
fermi        # start a session
```

Updates: `fermi update` stages the latest release for the next restart. `fermi update --check` checks without staging.

## Context Management

The core feature. The agent has two tools for inspecting and compressing its own context:

| Tool | What it does |
|------|-------------|
| `show_context` | Display a context map — all groups with token sizes, types, and content previews |
| `summarize_context` | Summarize selected context groups — extract decisions and facts, discard the rest |

The user can also intervene directly:

| Command | What it does |
|---------|-------------|
| `/summarize` | Interactive range picker — select turns, provide a focus prompt |
| `/compact` | Full context reset with continuation summary |

Three layers prevent context from ever silently overflowing:

```
Context usage ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100%
               ▲ 50%            ▲ 75%       ▲ 85%    ▲ 90%
               hint L1          hint L2     compact   compact
               (nudge)          (urgent)   (before    (mid-
                                            turn)     turn)
```

[Full context management guide →](https://felixruigao.github.io/Fermi/guide/context)

## Rich Terminal UI

Every detail is accessible without leaving the terminal. Tool results, file diffs, and bash output are shown inline with smart truncation — click any entry to expand the full content in a dedicated detail view. Sub-agents get their own conversation tabs; click an agent name or use `Opt+←/→` to switch between them.

![Sub-agent detail page — full review output with its own tab, agent status, and todos](assets/sub-agent-page.png)

- **Syntax-highlighted diffs** — file edits shown as red/green hunks with context lines; writes render with line numbers
- **Clickable file paths** — hover highlights, click opens in your editor
- **Live status bar** — agent count, plan progress, model name, permission mode, context usage with token counts
- **Tool grouping** — consecutive reads/searches collapse into a summary like "Explored (Read ×3, Search ×2)"

## Sub-Agents

The agent spawns parallel workers with their own context windows:

```
spawn(id="auth-check", template="explorer", mode="oneshot", model_level="low", task="...")
```

- **Templates:** `explorer` (read-only), `worker` (file + shell access), `reviewer` (fresh-eyes verification)
- **Model tiers:** Assign high/medium/low models via `/tier` — save cost on simple tasks
- **Modes:** `oneshot` (run once, return result) or `persistent` (stays alive, receives messages)

## Session Control

- **Async messaging** — type while the agent works. Messages queue and deliver when the agent pauses between actions.
- **Rewind** — `/rewind` rolls back to any previous turn, reverting conversation **and** file changes.
- **Fork** — `/fork` branches the current session into a new direction.
- **Persistent memory** — `AGENTS.md` files (global + project) survive compact and session restarts.

---

## Providers

Anthropic · OpenAI · GitHub Copilot · DeepSeek · Kimi · MiniMax · GLM · Qwen · Xiaomi · OpenRouter · Ollama · oMLX · LM Studio

Cloud or local, your choice. Switch at runtime with `/model`. `fermi init` handles setup.

[Provider setup guide →](https://felixruigao.github.io/Fermi/providers/)

## Key Commands

`/model` switch model · `/key` manage API keys · `/summarize` compress context · `/compact` full reset · `/rewind` (`/undo`) undo turns + files · `/permission` safety mode · `/tier` sub-agent models · `/session` resume · `/fork` branch session · `/skills` manage skills · `/mcp` MCP tools

[Full command reference →](https://felixruigao.github.io/Fermi/guide/commands)

## Limitations

- **Supported release builds:** macOS (Apple Silicon), Linux (x86_64, arm64), Windows (x64, arm64)
- **No sandbox** — shell commands and file edits execute directly (use `/permission` to control)
- **Third-party coding plans** (Kimi-Code, GLM-Code) use provider-side whitelists and may reject requests

Full documentation: **[felixruigao.github.io/Fermi](https://felixruigao.github.io/Fermi/)**

## Interfaces

- **Terminal (TUI)** — the primary interface, built on [OpenTUI](https://github.com/anomalyco/opentui). Run with `fermi` or `bun run dev`.
- **VS Code extension** (`vscode/`) — a sidebar chat panel driving the same backend. Streaming markdown, tool-call cards with inline diffs, permission approval, model picker, slash commands, and `@file` context. Sessions are shared with the TUI, so terminal conversations show up in the extension's history and vice versa. Works over Remote SSH (runs on the remote host) with one-click `fermi` install when the binary is missing.
- **Desktop (GUI)** — an Electron app in early development (`gui/`). Same runtime, different frontend.

## Development

```bash
bun install         # Install dependencies
bun run dev         # Run the TUI (OpenTUI)
bun run build       # Build binary
bun test            # Run tests
bun run typecheck   # Type check
```

## License

[MIT](./LICENSE). The TUI uses [OpenTUI](https://github.com/anomalyco/opentui) (MIT).
