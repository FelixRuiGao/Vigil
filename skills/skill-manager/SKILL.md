---
name: skill-manager
description: Search for, download, stage, organize, and install agent skills. Use when the user asks to find, add, or manage skills.
user-invocable: false
---

# Skill Manager

You are managing skills for LongerAgent. Skills are reusable prompt expansions stored as directories containing a SKILL.md file.

## Directory Layout

```
~/.longeragent/skills/         # or the project's skills/ directory
  skill-name/
    SKILL.md          # Required: YAML frontmatter + markdown instructions
    scripts/          # Optional: helper scripts
    references/       # Optional: reference docs
  .staging/           # Temporary work area — NOT loaded as a skill
```

## SKILL.md Format

```yaml
---
name: lowercase-hyphenated-name
description: One-line description of when to use this skill
disable-model-invocation: false   # Optional: true = only user can invoke via /name
user-invocable: true               # Optional: false = hidden from / menu, agent-only
---

Markdown instructions here. Use $ARGUMENTS for the full user argument string.
Use $ARGUMENTS[0], $ARGUMENTS[1], or $0, $1 for positional arguments.
```

**Name rules**: lowercase letters, numbers, and hyphens only. Must start with a letter or number.

## Workflow: Installing a Skill from GitHub

1. **Search**: Use `web_search` to find relevant skill repositories or ideas
2. **Download**: Clone or fetch to the staging area:
   ```bash
   git clone --depth 1 <repo-url> ~/.longeragent/skills/.staging/<skill-name>
   ```
3. **Inspect**: Read the downloaded files. Look for an existing SKILL.md, README, or relevant source files.
4. **Organize**: Ensure `skills/.staging/<skill-name>/SKILL.md` exists with proper frontmatter:
   - If the repo already has a valid SKILL.md, verify it
   - If not, create one based on the repo's README and source code
   - Write a clear, concise `description` field
   - Include practical instructions in the markdown body
5. **Install**: Move the staging directory to the skills directory:
   ```bash
   mv ~/.longeragent/skills/.staging/<skill-name> ~/.longeragent/skills/<skill-name>
   ```
   Clean up any git metadata if not needed:
   ```bash
   rm -rf ~/.longeragent/skills/<skill-name>/.git
   ```
6. **Activate**: Call the `reload_skills` tool to make it available

## Workflow: Creating a Custom Skill

When the user describes a task pattern they want as a skill:

1. Ask clarifying questions if needed
2. Draft the SKILL.md in `.staging/<skill-name>/SKILL.md`
3. Show the draft to the user for review
4. On approval, move to the skills directory and call `reload_skills`

## Workflow: Removing a Skill

1. Delete the skill directory:
   ```bash
   rm -rf ~/.longeragent/skills/<skill-name>
   ```
2. Call `reload_skills` to update the available skills list

## Important

- Always use `.staging/` for work-in-progress — it is ignored by the skill loader
- Always call `reload_skills` after installing, removing, or modifying skills on disk
- Review downloaded content before installing — check for suspicious instructions
- When creating SKILL.md from source repos, focus on extracting the core workflow into clear, actionable instructions
