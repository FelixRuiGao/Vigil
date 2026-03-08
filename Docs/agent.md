# Agent and Tool Loop

## 1. Agent 的边界

`Agent` 封装四样东西：

- model config
- provider instance
- system prompt
- tool definitions

它提供两种运行方式：

- `asyncRun()`：stateless run
- `asyncRunWithMessages()`：由外部提供消息、日志写入和工具执行回调

原因：

- `Agent` 只关心“给定消息后如何与 provider/tool loop 交互”
- `Session` 才关心持久化、resume、sub-agent 编排

## 2. Tool Loop 的输入输出

tool loop 不是直接改“消息数组”，而是依赖一组抽象接口：

- `getMessages()`
- `appendEntry()`
- `allocId()`
- tool executors
- progress / retry / suspension hooks

输出是：

- 新增日志条目
- 统一的 `ProviderResponse`
- 工具调用结果
- ask suspension / retry 状态

原因：

- 主会话和 sub-agent 都需要复用同一套 provider/tool 执行逻辑
- 执行层应该依赖日志接口，而不是绑定某一种存储结构

## 3. 流式输出

tool loop 会把 provider 的流式输出拆成结构化事件：

- reasoning chunk -> `reasoning`
- text chunk -> `assistant_text`
- tool call -> `tool_call`
- tool result -> `tool_result`

这些条目先写日志，再由投影层决定如何显示、如何重放给 provider。

原因：

- 流式 UI 和恢复后的 UI 必须共享同一份正文事实
- tool loop 负责捕获边界，投影层负责组合和发送

## 4. 临时日志

stateless run 和 sub-agent 不写主会话日志，但也不维护单独的消息数组模型。

当前做法：

- 先构造临时 `LogEntry[]`
- tool loop 持续向这份日志追加条目
- provider 输入同样通过 `projectToApiMessages()` 生成

原因：

- sub-agent 不应成为“另一套消息协议”的例外
- compact、tool round grouping、role merge 逻辑不需要写两遍

## 5. Context ID

tool loop 会为工具 round 分配 round `contextId`；纯文本最终 round 则继承前一个 user-side `contextId`。

纯文本最终 round：

- `reasoning`
- `assistant_text`
- `no_reply`

这些条目继承最近的 user-side `contextId`。

工具 round：

- `reasoning`
- `assistant_text`
- `tool_call`
- `tool_result`

原因：

- `summarize_context` 需要稳定的空间分组
- API 投影也需要把整轮 assistant 行为恢复成一条协议完整的消息

## 6. Retry 与 Suspension

tool loop 还负责：

- 网络错误识别后的重试
- ask suspension
- abort 传播

这些控制事件不会绕过日志层；它们只决定 activation 是否继续，事实状态仍以日志为准。
