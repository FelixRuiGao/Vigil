/**
 * Web search tool definition and pass-through handler.
 *
 * Provides the `web_search` ToolDef used by all agents.  Providers with
 * native search (Anthropic, OpenAI, GLM, Kimi) replace this ToolDef
 * in their `convertTools()` method with provider-specific formats.
 * Providers without native search (MiniMax) skip `web_search`
 * entirely — no client-side fallback is currently configured.
 *
 * Also provides a `$web_search` pass-through handler for Kimi's built-in
 * search on the OpenAI-compatible endpoint (echo protocol).
 */

import type { ToolDef } from "../providers/base.js";

// ------------------------------------------------------------------
// Tool definition
// ------------------------------------------------------------------

export const WEB_SEARCH: ToolDef = {
  name: "web_search",
  description:
    "Search the web for current information. " +
    "Returns titles, URLs and snippets for the top results.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query",
      },
      num_results: {
        type: "integer",
        description: "Number of results to return (default: 5)",
        default: 5,
      },
    },
    required: ["query"],
  },
  summaryTemplate: "{agent} is searching the web for '{query}'",
};

// ------------------------------------------------------------------
// Pass-through for Kimi $web_search
// ------------------------------------------------------------------

/**
 * Kimi $web_search pass-through: echo arguments back for server-side execution.
 *
 * Kimi's API uses a `builtin_function.$web_search` tool type. When the model
 * returns a `$web_search` tool call, the client must echo the arguments back
 * as a tool result. The server then processes the search and generates the
 * final response incorporating search results.
 */
export function toolBuiltinWebSearchPassthrough(
  kwargs: Record<string, unknown>,
): string {
  return JSON.stringify(kwargs);
}
