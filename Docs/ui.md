# TUI Architecture

## 1. 正文来源

TUI 正文只来自日志投影。

当前实现：

- `App` 持有当前 `Session`
- `App` 订阅 `session.subscribeLog()`
- 日志变化时调用 `projectToTuiEntries()`
- `ConversationPanel` 只渲染投影结果

原因：

- live 与 `/resume` 必须看到同一份正文
- UI 不应该再维护第二份“自己拼出来的对话历史”

## 2. 瞬时状态

progress 事件仍然存在，但只负责瞬时状态：

- 当前 phase
- 当前工具名
- retry 反馈
- ask 面板开关
- token / cache 指标

这些状态不会反向生成正文内容。

原因：

- progress 是过程信号，适合状态栏，不适合作为事实存储
- 把正文和瞬时状态分开后，UI 行为更稳定，也更容易恢复

## 3. 主要组件

- `ConversationPanel`
  - 渲染投影后的正文列表
- `InputPanel`
  - 输入框、slash command 选项层、`/resume` 会话列表
- `AskPanel`
  - 展示结构化问题并提交用户答案
  - 高亮即选中：→ 跳题 / Tab 保存 note 时自动确认当前选项
  - 多问题 review 确认界面（Enter 提交 / Esc 返回 / 数字键跳转编辑）
  - 支持选项 + Tab 附加 note（per-option 独立存储）
  - custom input 和 note 共用内联编辑器（复用 `editor-state.ts` 纯函数），支持光标移动和行编辑
  - 回答后在 TUI 中以 `tool_result` preview 显示问题 + 选项 + 用户回答
- `StatusBar`
  - 展示 phase、model、occupied context、cache read tokens 等指标

## 4. Slash Commands

当前内置命令：

- `/help`
- `/new`
- `/resume`
- `/model`
- `/thinking`
- `/cachehit`
- `/quit`
- `/exit`

这些命令修改的是 `Session` 或运行时配置，不直接拼接正文。

## 5. 为什么采用这种结构

- `Session` 专注日志和控制流
- TUI 专注显示和交互
- 正文来自日志投影，状态栏来自 progress，两条链各自清晰
