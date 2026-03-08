# Session Log Architecture

## 1. 核心原则

LongerAgent 以结构化日志作为唯一事实源。

运行时的所有长期状态都先写入 `LogEntry[]`，然后再派生出两类投影：

- `projectToTuiEntries()`：给 TUI 正文使用
- `projectToApiMessages()`：给 provider 请求使用

这样设计的原因：

- live 与 `/resume` 使用同一份数据和同一套规则
- summarize、compact、ask、repair 可以围绕同一种数据结构工作
- 避免 UI 状态、provider message history、持久化文件三套模型漂移

## 2. Log Entry 的职责

每条日志同时表达三件事：

- 发生了什么：`type`
- 对用户怎么显示：`tuiVisible`、`displayKind`、`display`
- 对模型怎么重放：`apiRole`、`content`

额外状态位：

- `summarized`
- `summarizedBy`
- `discarded`
- `archived`
- `meta`

这样做的原因：

- 日志要同时服务 UI、provider 和恢复逻辑
- summarize / compact 不需要删除历史，只需要改变可见性和引用关系

## 3. Context ID 与 Round

上下文压缩依赖结构化 `contextId`，不依赖正文字符串解析。

当前规则：

- `user_message` 自带独立 `contextId`
- 纯文本最终 round 的 `reasoning`、`assistant_text`、`no_reply` 继承最近的 user-side `contextId`
- 工具 round 的 `reasoning`、`assistant_text`、`tool_call`、`tool_result` 共享一个 round `contextId`
- `summary`、`compact_context` 也有自己的 `contextId`

原因：

- `summarize_context` 需要在日志层做空间索引和连续性校验
- tool round 必须能整体折叠，否则 summary 会切裂一个 provider round
- 纯文本最终 round 继承 user-side `contextId`，可以让 `show_context` 和 `summarize_context` 把一次完整问答视为同一组

## 4. TUI 投影

TUI 正文完全来自日志投影。

当前实现：

- `App` 订阅 `session.subscribeLog()`
- 每次日志变化调用 `projectToTuiEntries()`
- `ConversationPanel` 只渲染投影结果

progress 事件只保留给瞬时状态：

- phase
- 当前工具名
- ask 面板开关
- retry 提示
- token 和 cache 指标

原因：

- 正文只能有一个来源，live 和 resume 才能严格一致
- progress 是瞬时信号，不适合承担事实存储

## 5. API 投影

provider 输入由 `projectToApiMessages()` 统一生成。

当前规则：

- 取 system prompt
- 找到最后一个 `compact_marker`，只发送当前 active window
- 把 `compact_context` 作为窗口起点重新注入
- 将同一 round 的 `reasoning` / `assistant_text` / `tool_call` 组合成 assistant message
- `tool_result` 以独立 tool message 输出
- 在投影阶段处理图片、important log、连续同 role 合并
- 在投影阶段截断过长的 `summarize_context` 参数摘要

原因：

- provider 需要的是稳定、最小、可重放的消息序列
- 图片解析、compact window、role alternation 都是发送前转换，不应污染事实日志

## 6. summarize_context

`summarize_context` 直接操作日志：

- 建立当前可见 window 的 spatial index
- 验证 `context_ids` 是否存在、连续、未跨 compact 边界
- 插入 `summary` entry
- 把被覆盖的原条目标记为 `summarized`

原因：

- summary 是真实上下文状态，不是单纯的 prompt 优化
- 直接改日志，resume、compact、repair 才能一致理解 summary 的含义

## 7. Compact 与 Archive

compact 是整窗重建，不是局部折叠。

当前流程：

1. 先 drain pending messages 和未投递的 sub-agent 结果
2. 进入 compact phase，生成 continuation 所需信息
3. 写入 `compact_marker` 和新的 `compact_context`
4. 将旧 window 的重量级内容归档到 `archive/window-N.json.gz`

compact phase 产生的内部条目仍会写入日志，但默认不进入正常正文。

原因：

- compact 必须基于压缩时刻的真实世界状态
- 归档让长会话可恢复，同时避免活跃窗口无限膨胀

## 8. Ask

`ask` 是日志协议的一部分，不是 UI 特例。

顺序是：

- assistant 发出 `ask` tool call
- Session 记录 `ask_request`
- 用户回答后记录 `ask_resolution`
- Session 立即补对应 `tool_result`
- 如有必要，再追加 follow-up `user_message`

原因：

- provider 协议要求 tool call / tool result 闭环
- `/resume` 必须只依赖日志，不依赖进程内残留状态

## 9. 持久化与恢复

持久化只保存当前日志格式：

- `log.json`
- `archive/window-N.json.gz`

`restoreFromLog()` 恢复：

- `_log`
- `LogIdAllocator`
- token 和 cache 计数
- ask 状态
- used context ids

原因：

- 只保留一种持久化格式，恢复逻辑才简单且可验证
- active log 和 archive 分离，既能恢复，又不会让内存窗口长期背负旧内容
