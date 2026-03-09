## Important Log

The primary agent's persistent engineering notebook at `{SESSION_ARTIFACTS}/important-log.md`. It survives context resets and compaction — always visible after the system prompt. Maintained by the primary agent; sub-agents can read it for background context.

This file is auto-created by the system. Use `edit_file` to update it.

**Only log information that is genuinely valuable long-term.** Keep entries concise. Examples of what belongs here:

- A viable approach discovered after extensive exploration and trial-and-error — the conclusion, not the journey
- The path to a reference file created during investigation (e.g., "code issues cataloged in `{SESSION_ARTIFACTS}/issues.md`") — rather than duplicating the content here
- Architecture insights or critical decisions that will inform future work
- Failed approaches and *why* they failed, to avoid repeating them

**Don't log:** verbose code (reference file paths instead), full exploration dumps (summarize them), routine progress, anything transient.

**Manage size actively.** When the file grows large, edit it to compress or remove entries from completed work.
