# Tool System

## 1. 当前工具集合

### 基础工具

定义在 `src/tools/basic.ts`：

- `read_file`
- `list_dir`
- `glob`
- `grep`
- `edit_file`
- `write_file`
- `apply_patch`
- `bash`
- `diff`
- `test`
- `web_search`
- `web_fetch`

这些工具直接操作文件、命令、网络或测试环境，返回 `ToolResult`。

### 会话编排工具

定义在 `src/tools/comm.ts`，由 `Session` 解释：

- `spawn_agent`
- `kill_agent`
- `bash_background`
- `bash_output`
- `kill_shell`
- `check_status`
- `wait`
- `show_context`
- `summarize_context`
- `ask`

### 动态工具

- `skill`
  - 由 `Session` 根据已加载 skills 动态生成并注入

## 2. 为什么分层

基础工具和编排工具承担的是不同职责：

- 基础工具操作外部世界
- 编排工具改变会话控制流和上下文结构

这样拆分后：

- provider 仍然只看到统一的 tool schema
- Session 可以对编排工具施加状态机约束
- 安全边界可以集中保护 I/O 工具

## 3. 安全模型

基础工具当前具备这些约束：

- 文件路径通过 `safePath()` 校验
- 敏感文件读取有额外拦截
- `bash` 受 cwd、timeout、输出大小限制约束
- `bash_background` / `bash_output` / `kill_shell` 由 Session 跟踪后台进程状态，并把完整日志写到 session artifacts
- `grep` / `glob` 受搜索范围、深度、结果数和总扫描量限制约束
- `write_file` / `edit_file` 支持 mtime optimistic concurrency guard
- `apply_patch` 先完整解析与校验，再开始写文件；失败时不应留下校验阶段的副作用

## 4. `show_context` / `summarize_context` / `ask`

这几个工具虽然以“tool”形式暴露给模型，但本质上是日志协议的一部分：

- `show_context` 展示当前 active window 的 context 分布，并在下一次 provider round 中临时打开详细 annotation
- `summarize_context` 会改写当前可见上下文窗口
- `ask` 会挂起 activation，等待用户回答，再以 `tool_result` 闭环

## 5. 大文件与长日志

当前推荐工作流：

- 对大文件、长日志、长输出，优先先搜索，再阅读相关片段
- 对长时间 shell 任务，优先使用：
  - `bash_background`
  - `bash_output`
  - `wait`
- 对大文件生成，优先使用：
  - `write_file` 写开头/骨架
  - `apply_patch` 分块追加

原因：

- 模型需要主动触发这些操作
- 但真正的数据修改权必须由 Session 掌握
