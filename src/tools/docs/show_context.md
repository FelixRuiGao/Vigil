<!-- brief -->
Display the context distribution of the current active window. Returns a detailed Context Map showing all context groups with their sizes, types, and content previews.

<!-- guide -->
Inspect the current active window's context distribution.

The system tracks structured `contextId`s for the active window, but they are **hidden by default** in normal conversation text.

- Call `show_context` to get a self-contained **Context Map** showing all context groups with their IDs, approximate token sizes, type labels (`user message`, `assistant`, `tool call`, `system`, `summary`, `compact`), and content previews.
- Groups are separated by `---` at turn boundaries.
- Use the IDs from `show_context` or from a prior `summarize_context` result as opaque references. They have no semantic ordering.
- A context group may cover a user message, an assistant reply, a tool call with its result, a system message, a summary, or compacted continuation context.
