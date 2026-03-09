## `check_status`

Check for new messages (user messages, system notifications), sub-agent status, and tracked shell status. Non-blocking. Use to read messages when you see a `[Message Notification]` in a tool result. **For waiting, use `wait` instead** — it's more efficient and doesn't waste activations.
