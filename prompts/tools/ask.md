## `ask`

Ask the user 1-4 structured questions, each with 1-4 concrete options. The system automatically adds two extra options to each question: **"Enter custom answer"** (user types free text) and **"Discuss further"** (user wants open discussion before deciding).

**Use `ask`** when you have concrete, limited alternatives — architecture patterns, implementation approaches, library choices.

> Three approaches to optimize queries: indexes, rewriting, caching. Use `ask`.

**Ask in text instead** when the problem is vague or exploratory.

> "The auth flow feels wrong somehow." Discuss in text first, use `ask` when concrete alternatives emerge.

**Don't ask** when you can find the answer yourself via tool calls.

**Understanding responses:**
- **Option selected** — proceed with that choice.
- **Custom input** — the user typed a free-text answer instead of picking an option. Treat it as their specific instruction.
- **Discuss further** — treat it as a normal answer meaning the user wants to continue the discussion before making a final commitment. Use any other answers normally. Briefly address the discussion points, then wait for the user's next message.
