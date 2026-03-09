## `show_context`

Inspect the current active window's context distribution.

The system tracks structured `contextId`s for the active window, but they are **hidden by default** in normal conversation text.

- Call `show_context` to reveal all visible context groups, including their IDs, approximate sizes, and what each group covers.
- Returns a compact **Context Map** showing all context groups with their sizes and types.
- Makes detailed inline annotations visible at each context group. Annotations remain active until the next `summarize_context` call (auto-dismissed) or until you call `show_context(dismiss=true)`.
- Use the IDs from `show_context` or from a prior `summarize_context` result as opaque references. They have no semantic ordering.
- A context group may cover a user message, a tool round, a summary, or compacted continuation context.
- System messages do not participate in this context grouping scheme.
