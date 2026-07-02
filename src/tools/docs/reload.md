<!-- brief -->
Reload skills, MCP servers, and the system prompt from disk. Call after writing or editing SKILL.md files, AGENTS.md, or MCP config (settings.json mcp_servers). Returns a summary of what changed.

<!-- guide -->
Reload skills, MCP servers, and the system prompt from disk. Call after writing or editing:
- `SKILL.md` files (install/update/remove skills)
- `AGENTS.md` (persistent memory)
- `settings.json` `mcp_servers` section (add/remove/change MCP servers)

You can batch multiple writes then call reload once. Returns a summary of what changed.

Skill and MCP tool availability can change during a session when the user enables, disables, connects, disconnects, or reloads them. If a skill or MCP tool appears or disappears compared with earlier turns, treat that as normal runtime configuration behavior. Do not infer from the availability change alone that your earlier answer or reasoning was wrong; use the tools currently available in this turn.
