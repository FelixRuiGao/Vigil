---
name: custom-template
description: How to create a custom sub-agent template when the predefined explorer/worker/reviewer templates don't fit. Use when you need to spawn a sub-agent with a custom role, tool set, or system prompt.
---

# Creating a Custom Sub-Agent Template

Only create a custom template when none of `explorer`, `worker`, or `reviewer` fits the task — they almost always do.

## Steps

**Step 1.** Create a template directory with two files in `{SESSION_ARTIFACTS}`:

```
write_file(path="{SESSION_ARTIFACTS}/my-template/agent.yaml", content=...)
write_file(path="{SESSION_ARTIFACTS}/my-template/system_prompt.md", content=...)
```

**`agent.yaml` structure:**

```yaml
type: agent
name: my-template
description: "Brief description of the agent's role."
system_prompt_file: system_prompt.md
tool_tier: read_only        # preferred: read_only | reversible | all
max_tool_rounds: 100
```

- `max_tool_rounds` is required and must be **>= 100**.
- The tool set is required: declare either `tool_tier` (preferred) or an explicit `tools` list — omitting both is a validation error.
- Usage guides for the declared tools are generated into the sub-agent's system prompt automatically — write only the role and constraints, never tool documentation.

**Tool packs** — use these in the `tools` field instead of listing individual tools:

| Pack | Tools included |
|------|---------------|
| `read` | `read_file`, `list_dir`, `glob`, `grep` |
| `edit` | `write_file`, `edit_file` |
| `shell` | `bash`, `bash_background`, `bash_output`, `kill_shell` |
| `util` | `time`, `web_search`, `web_fetch` |

Packs and individual tool names can be mixed: `tools: [read, bash, time]`. Tiers expand to packs: `read_only` = read + util, `reversible` = read + edit + shell + util.

**`system_prompt.md`:** Write a focused prompt for the sub-agent's role — include its specific task type, output expectations, and constraints.

**Step 2.** Reference it with `template_path`:

```
spawn(id="analyst-1", template_path="my-template", mode="oneshot", task="Analyze the database schema at ...")
```

The template persists in `{SESSION_ARTIFACTS}` for the entire session — you can reuse it across multiple `spawn` calls without recreating it.
