/**
 * Model-specific system prompt overlays.
 *
 * An ordered table of (matcher → whole prompt block). The FIRST matching
 * entry wins; later entries are ignored. Order the table fine-to-coarse:
 * exact-model rows first, family/provider rows next, the openModel
 * catch-all last. An entry with empty content switches the overlay off for
 * whatever it matches.
 *
 * Reuse is by string constants, not by stacking: a model-specific variant
 * writes `content: OPEN_MODEL_GUARDRAILS + "\n\n" + EXTRA` so the shared
 * text is referenced, never copied out where it could drift. Exactly one
 * block reaches the prompt, so entries can never contradict each other.
 *
 * Callers must rebuild the cached system prompt when the model changes
 * (Session.switchModel / reloadCurrentModelConfig do this); a model switch
 * invalidates the provider-side prompt cache anyway, so the rebuild is free.
 */

import {
  isAnthropicFamilyModel,
  isOpenAIFamilyModel,
  stripVendorPrefix,
} from "./thinking-artifact.js";

export const OPEN_MODEL_GUARDRAILS = `Reminders for the current model family, on top of everything above:

- Before editing a file, \`read_file\` it in this conversation first — and re-read it if it may have changed since your last read. Never construct \`old_str\` from memory.
- Never issue two \`edit_file\`/\`write_file\` calls against the same file in the same response.
- Pass absolute paths to file tools; build them from the project root rather than assuming a working directory.
- Before running a project script (\`npm run lint\`, \`pnpm test\`, …), confirm it exists in the relevant manifest (package.json, Makefile, …) instead of guessing script names.
- Prefer reading larger ranges (a few hundred lines) over many small chunked reads of the same file.
- You may issue many tool calls in a single response — when calls are independent (reads, searches, status checks), batch them in parallel rather than limiting yourself to a few.
- Follow the tool JSON schemas exactly: include every required parameter, and never invent parameters that are not declared.`;

export interface OverlayMatch {
  /** Neither Anthropic-family (claude-…) nor OpenAI-family (gpt-…, oN) model. */
  openModel?: true;
  /** Vendor-prefix-stripped model id equals this or starts with `${family}-`. */
  family?: string;
  /** Provider id, exact match (orthogonal to model family — e.g. "copilot"). */
  provider?: string;
  /** Vendor-prefix-stripped model id: exact string, or a RegExp tested against it. */
  model?: string | RegExp;
}

export interface OverlayEntry {
  id: string;
  match: OverlayMatch;
  /** Self-contained block, no top-level heading. "" disables the overlay. */
  content: string;
}

/** All present match fields must hold (AND); absent fields don't participate. */
export function overlayMatches(
  match: OverlayMatch,
  provider: string,
  model: string,
): boolean {
  const id = stripVendorPrefix(model).toLowerCase();
  if (match.openModel && (isAnthropicFamilyModel(model) || isOpenAIFamilyModel(model))) {
    return false;
  }
  if (match.family !== undefined) {
    const family = match.family.toLowerCase();
    if (id !== family && !id.startsWith(family + "-")) return false;
  }
  if (match.provider !== undefined && provider.toLowerCase() !== match.provider.toLowerCase()) {
    return false;
  }
  if (match.model !== undefined) {
    if (typeof match.model === "string") {
      if (id !== match.model.toLowerCase()) return false;
    } else if (!match.model.test(stripVendorPrefix(model))) {
      return false;
    }
  }
  return true;
}

/**
 * The overlay table — ordered fine-to-coarse, first match wins.
 *
 * Examples of finer rows (add ABOVE the catch-all):
 *   { id: "kimi-k3", match: { model: "kimi-k3" }, content: "" }              // off for this model
 *   { id: "glm-notes", match: { family: "glm" },
 *     content: OPEN_MODEL_GUARDRAILS + "\n\n" + GLM_EXTRA }                  // variant via constants
 */
const OVERLAYS: OverlayEntry[] = [
  { id: "open-model-guardrails", match: { openModel: true }, content: OPEN_MODEL_GUARDRAILS },
];

/**
 * The overlay block for a (provider, model), or "" when nothing applies.
 */
export function buildModelOverlay(provider: string, model: string): string {
  if (!model) return "";
  const hit = OVERLAYS.find((e) => overlayMatches(e.match, provider, model));
  if (!hit || !hit.content) return "";
  return "# Model-Specific Guidance\n\n" + hit.content;
}
