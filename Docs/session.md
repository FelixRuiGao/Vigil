# Session Runtime

## 1. Session 的职责

`Session` 是主运行时编排器，负责：

- turn / activation loop
- 外部消息投递
- sub-agent 生命周期
- ask suspension / resume
- summarize / compact
- 图片附件、重要日志、MCP 工具接入
- log-native 持久化

`Session` 不维护 provider message history；它维护的是结构化日志和少量瞬时控制状态。

## 2. Turn 与 Activation

一次用户交互不是单次 provider 调用，而是一段 activation 序列。

典型流程：

1. 写入用户输入和 turn 开始相关日志
2. 调用 primary agent 的 tool loop
3. 把 reasoning、assistant text、tool call、tool result 追加到日志
4. 在 activation 边界处理消息队列和 sub-agent 结果
5. 需要时触发 summarize 或 compact
6. 请求保存

这样设计的原因：

- 工具调用、ask、sub-agent 完成都会打断一次“单轮对话”
- 只有把这些中间状态写成日志，系统才能在中断、恢复和继续执行之间保持一致

## 3. 外部消息投递

所有外部消息统一通过 `_deliverMessage(source, content)` 进入运行时。

根据 `_agentState`：

- `idle`：直接写入日志
- `working`：进入 `_messageQueue`
- `waiting`：进入 `_messageQueue` 并唤醒 `wait`

消息最终通过两条路径进入上下文：

- tool-result notification
- activation boundary drain

原因：

- user、system、sub-agent 不应各走一套模型
- `wait`、`check_status`、恢复后的继续执行都需要共享同一份待投递状态

## 4. Sub-Agent 管理

sub-agent 由 `spawn_agent` 创建，`Session` 负责：

- 创建 agent
- 跟踪状态
- 接收最终结果
- 在合适的边界把结果投递回主会话

sub-agent 运行时不直接写主日志；它使用自己的临时结构化日志。

原因：

- 主会话只需要 sub-agent 的结果和状态，不需要接管其内部上下文
- 临时日志让 sub-agent 与主会话共享同一套 provider 投影规则

## 5. Ask

当 tool loop 遇到 `ask`：

- 当前 activation 暂停
- Session 写入 `ask_request`
- TUI 打开 ask 面板
- 用户提交后写入 `ask_resolution` 和对应 `tool_result`
- 需要时追加 follow-up user message
- 然后继续 activation

原因：

- `ask` 是 provider 协议的一部分
- 只有写成日志闭环，resume 才是可靠的

## 6. Summarize 与 Compact

`summarize_context`：

- 只处理当前可见 compact window 内的 context
- 用 `summary` entry 替换一段连续上下文

compact：

- 先 drain pending state
- 再进入 compact phase 生成 continuation 所需信息
- 写入 `compact_marker` 和新的 `compact_context`
- 归档旧 window 的重量级内容

原因：

- summarize 是局部压缩
- compact 是整窗重建
- 两者都必须围绕同一份日志工作

## 7. 保存与恢复

`Session` 不直接决定何时落盘；它通过 `onSaveRequest` 发出“值得保存”的信号。

序列化接口：

- `getLogForPersistence()`
- `restoreFromLog()`

恢复时会重建：

- 日志
- id allocator
- token / cache 指标
- ask 状态
- context id 使用集合

这样做的原因：

- CLI/TUI 可以自由决定 autosave 策略
- 运行时只暴露可序列化状态，不绑 UI 生命周期
