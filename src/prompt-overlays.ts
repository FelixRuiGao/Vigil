/**
 * Model-family system prompt overlays.
 *
 * A small, appended guidance block selected by the CURRENT model (unlike
 * {INITIAL_MODEL}, which is fixed at session creation). Today there is one
 * overlay: guardrails for open-vendor models (Kimi / DeepSeek / GLM / Qwen /
 * MiniMax / MiMo / …) — everything that is neither Anthropic- nor
 * OpenAI-family. Claude and GPT models get no overlay.
 *
 * Selection is whole-block per family: either the block is present or it
 * isn't. No fragment-level shuffling — that would reintroduce the invisible
 * assembly this redesign removed.
 *
 * Callers must rebuild the cached system prompt when the model changes
 * (Session.switchModel / reloadCurrentModelConfig do this); a model switch
 * invalidates the provider-side prompt cache anyway, so the rebuild is free.
 */

import { isAnthropicFamilyModel, isOpenAIFamilyModel } from "./thinking-artifact.js";

const OPEN_MODEL_GUARDRAILS = `# Model-Specific Guidance

Reminders for the current model family, on top of everything above:

- Before editing a file, \`read_file\` it in this conversation first — and re-read it if it may have changed since your last read. Never construct \`old_str\` from memory.
- Never issue two \`edit_file\`/\`write_file\` calls against the same file in the same response.
- Pass absolute paths to file tools; build them from the project root rather than assuming a working directory.
- Before running a project script (\`npm run lint\`, \`pnpm test\`, …), confirm it exists in the relevant manifest (package.json, Makefile, …) instead of guessing script names.
- Prefer reading larger ranges (a few hundred lines) over many small chunked reads of the same file.
- You may issue many tool calls in a single response — when calls are independent (reads, searches, status checks), batch them in parallel rather than limiting yourself to a few.
- Follow the tool JSON schemas exactly: include every required parameter, and never invent parameters that are not declared.`;

/**
 * The overlay for a model id, or "" when the family needs none.
 */
export function buildModelOverlay(model: string): string {
  if (!model) return "";
  if (isAnthropicFamilyModel(model) || isOpenAIFamilyModel(model)) return "";
  return OPEN_MODEL_GUARDRAILS;
}
