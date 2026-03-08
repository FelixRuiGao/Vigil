# Consecutive Role Handling

## 1. 日志层不强行交替角色

LongerAgent 的日志记录真实事件顺序，不在事实层强行维持 user / assistant 严格交替。

原因：

- 日志需要保留真实边界，方便 summarize、compact、repair、debug
- 是否允许连续同 role，取决于 provider，而不是取决于事实存储

## 2. 处理位置

连续同 role 的处理发生在 API 投影层。

`projectToApiMessages()` 会根据 provider 的 `requiresAlternatingRoles` 决定是否调用 `mergeConsecutiveSameRole()`。

## 3. 当前合并规则

- `system`：不合并
- `tool_result`：不合并
- `assistant(tool_calls)`：保持协议边界，不与后续 assistant tool call 混合
- `user + user`：按内容块合并
- `assistant + assistant`：纯文本时按空行合并

原因：

- provider 协议需要的是合法消息序列
- 日志需要的是完整事件边界
- 把合并推迟到发送前，才能兼顾两者
