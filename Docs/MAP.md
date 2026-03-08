# LongerAgent TypeScript Map

本文件只描述当前实现，以及这些模块为什么存在。

## 1. 启动入口

- `src/cli.ts`
  - CLI 入口。
  - 负责加载配置、模板、技能，创建 `SessionStore` 和 `Session`，然后启动 TUI。
- `src/index.ts`
  - 对外导出公共类型和运行时入口。

## 2. 核心运行时

- `src/session.ts`
  - 主会话编排器。
  - 负责 activation loop、消息投递、sub-agent、ask、summarize、compact、持久化对接。
- `src/log-entry.ts`
  - 结构化日志模型、entry 工厂、`LogIdAllocator`。
- `src/log-projection.ts`
  - 日志投影层。
  - `projectToTuiEntries()` 生成正文显示。
  - `projectToApiMessages()` 生成 provider 输入。
- `src/summarize-context.ts`
  - `summarize_context` 的 log-native 执行逻辑。
- `src/show-context.ts`
  - `show_context` 工具实现：Context Map 生成、注入点 annotation 生成、token 估算。
- `src/ephemeral-log.ts`
  - stateless run 和 sub-agent 使用的临时结构化日志。

这些文件共同实现一个原则：`Session._log` 是唯一事实源，正文和 provider 消息都从日志投影得到。

## 3. Agent 与 Tool Loop

- `src/agents/agent.ts`
  - `Agent` 封装 provider、system prompt 和 tool defs。
  - 提供 stateless run 和 callback 驱动的运行接口。
- `src/agents/tool-loop.ts`
  - 通用 provider/tool loop。
  - 负责流式输出、tool call、tool result、retry、ask suspension、多轮工具调用。

这一层只依赖抽象接口，不直接依赖 `Session` 的内部状态，因此主会话和 sub-agent 能共享同一套执行逻辑。

## 4. Provider 层

- `src/providers/base.ts`
  - provider 抽象、统一消息格式、`Usage`、`ProviderResponse`。
- `src/providers/registry.ts`
  - 根据 `ModelConfig.provider` 创建 provider 实例。
- 具体实现：
  - `src/providers/anthropic.ts`
  - `src/providers/openai-responses.ts`
  - `src/providers/openai-chat.ts`
  - `src/providers/kimi.ts`
  - `src/providers/glm.ts`
  - `src/providers/minimax.ts`
  - `src/providers/openrouter.ts`

provider 层的职责是把统一消息格式转换成各家 API 的请求，并把响应归一化回统一结构。

## 5. 工具系统

- `src/tools/basic.ts`
  - 基础 I/O 工具：
  - `read_file`
  - `list_dir`
  - `glob`
  - `grep`
  - `edit_file`
  - `write_file`
  - `bash`
  - `diff`
  - `test`
  - `web_search`
  - `web_fetch`
- `src/tools/comm.ts`
  - 会话编排工具：
  - `spawn_agent`
  - `kill_agent`
  - `check_status`
  - `wait`
  - `show_context`
  - `summarize_context`
  - `ask`
- `src/session.ts`
  - 动态注入 `skill` 工具。

拆分原因是：基础工具操作外部世界，会话工具改变运行时控制流；两者的安全边界和状态约束不同。

## 6. TUI

- `src/tui/app.tsx`
  - 主 UI 状态机。
  - 订阅日志并刷新正文；progress 事件只驱动状态栏和瞬时面板状态。
- `src/tui/components/conversation-panel.tsx`
  - 渲染投影后的正文列表。
- `src/tui/components/input-panel.tsx`
  - 输入框、slash command 选项层、`/resume` 列表。
- `src/tui/components/ask-panel.tsx`
  - ask 问题面板：选项选择、Tab 附加 per-option note、内联行编辑器（复用 `editor-state.ts`）。
- `src/tui/components/status-bar.tsx`
  - phase、model、occupied context、cache 命中等状态指标。
- `src/commands.ts`
  - slash commands 注册与执行。

## 7. 支撑模块

- `src/persistence.ts`
  - `SessionStore`、`saveLog()`、`loadLog()`、`validateAndRepairLog()`、archive helpers。
- `src/config.ts`
  - 配置加载、模型能力推断、路径占位渲染。
- `src/file-attach.ts`
  - `@file` 和图片附件解析。
- `src/context-rendering.ts`
  - provider 发送前的消息合并规则。
- `src/network-retry.ts`
  - retryable 错误识别和退避策略。
- `src/security/*`
  - 路径边界和敏感文件保护。
- `src/templates/loader.ts`
  - agent template 加载。
- `src/skills/loader.ts`
  - skills 元数据和正文加载。
- `src/mcp-client.ts`
  - MCP server 接入。

## 8. 当前设计原则

- 事实源只有日志。
- TUI 和 provider 输入都是投影，不自己维护第二份正文历史。
- summarize、compact、ask、repair 都直接围绕日志工作。
- 持久化只保存 `log.json` 和归档窗口，不保存第二套会话格式。

## 9. 文档索引

- `Docs/session-log-architecture.md`
  - 日志架构与投影规则。
- `Docs/session.md`
  - `Session` 运行时与 activation loop。
- `Docs/agent.md`
  - `Agent`、tool loop、临时日志。
- `Docs/message-architecture.md`
  - 当前消息模型。
- `Docs/message-delivery-v2.md`
  - 消息投递与队列机制。
- `Docs/consecutive-role-handling.md`
  - provider 角色交替处理。
- `Docs/ui.md`
  - TUI 架构与状态来源。
- `Docs/providers.md`
  - provider 抽象与差异。
- `Docs/tools.md`
  - 工具系统与安全边界。
- `Docs/config.md`
  - 配置模型与能力推断。
- `Docs/utilities.md`
  - persistence、security、templates、skills、attachments 等支撑模块。
