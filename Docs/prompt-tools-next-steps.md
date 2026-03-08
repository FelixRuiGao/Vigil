# Prompt and Tooling Next Steps

本文件记录当前 Prompt、工具与相关工作流的设计结论。

前半部分记录仍在讨论或后续要继续推进的方向。
后半部分记录已经完成的事项，作为当前实现与既定边界的说明。

## 1. System Prompt

当前共识：

- 不以“缩短长度”为目标。
- 工具说明和操作手册可以继续写在 System Prompt 中。
- 后续优化重点不是 token 数，而是：
  - 指令优先级是否清晰
  - 是否存在重复或冲突规则
  - Explorer / delegation 规则是否足够明确

已经确认应加入的推荐工作流：

- 对长文件、长日志、长输出，默认不要全文读取。
- 先用 `grep` 或其他定位工具搜索目标位置。
- 再用 `read_file(start_line, end_line)` 读取相关片段。
- 只有在确实需要整体结构时，才扩大阅读范围。
- 当系统明确提示“输出已截断”时，优先去完整日志文件或原始文件上搜索，而不是重复请求全文。

## 2. `spawn_agent` 与未来 Agent Team

当前共识：

- 保留当前 file-based `spawn_agent(file=...)` 作为 canonical 入口。
- 不应为了“更轻量”而放弃 call file / spec file 工作流。
- 因为模型在调用前可以反复 `edit_file` 修改 spec，这有助于产出更高质量的 sub-agent prompt。

未来如果加入更轻的调用方式：

- 只能作为语法糖存在。
- 底层仍应自动落到一个可编辑的 spec / call file 上。

未来 Agent Team 的工具设计应与一次性 sub-agent 分层：

- 一次性 sub-agent：
  - 无独立 Session
  - 生命周期短
  - 完成后回传结果
- Team member：
  - 有独立 Session
  - 有独立结构化日志
  - 可持续接收消息、继续工作

Team 成员之间的消息机制应复用现有消息投递原则：

- Agent 不工作时：消息直接注入为 `user_message`
- Agent 工作时：消息进入队列
- 消息通知通过 tool result / status 提示 Agent 主动拉取
- `check_status` / `wait` / activation boundary drain 使用同一种消费机制

## 3. Context ID / `show_context` / Summarize 提示链路 — ✅ 已完成

方向：

- 平时不显示 `context_id`。
- 通过一个单独的工具 `show_context` 来展示当前 active window 的 context 信息（只看当前 active window，会进入 provider 的可见内容范围）。
- `show_context` 每次显示全部 active window。
- `show_context` 的显示只维持一个 round，round 结束后自动关闭。
- 每次调用 `show_context` 都重新计算并覆盖显示。

`show_context` 的展示要求：

- 在 `show_context` 的 tool result 中加入 `context id map`。
- 按空间顺序展示各个 `contextId`，不按 token 数排序。
- `context id map` 中按空间顺序列出每个 `contextId`，以及它们对应的 estimated token 数。
- token 数使用模糊展示：
  - `9300` 显示为 `9k`
  - 小于 `1000` 显示为 `<1k`
- 对每个 `contextId`，展示它囊括的范围。
- 这种“范围展示”不要求原始结构化信息，尤其对 `tool_call` 这类非 text 内容，不要使用过于结构化的原始信息，而是做简短、可读的说明。
- 在展示中标注：
  - 这个 `contextId` 下总的 estimated token 数
  - 这个 `contextId` 下各单独部分的 estimated token 数
- 一致性前提：`tool_result` 必须有对应的 `tool_call`（按 `tool_call_id` 匹配）。

`show_context` 的定位：

- 不把它描述为“给 `summarize_context` 用的工具”。
- 只描述它本身的功能，并给出开启后的展示示例。
- `summarize_context` 的使用流程应在 `summarize_context` 工具说明中提到。
- 未来 `show_context` 的一个明确路径：主 Agent 在调用 Sub-Agent 时，允许按 `contextId` 选择部分上下文传入 Sub-Agent。
- 当前文档不把它绑定到 Agent Team 的特定显示流程。

Summarize 提示机制：

- 提示继续通过统一 delivery 机制注入，不改成 compact 式的特殊强制注入。
- 不再考虑工具 token 数。
- 只看总 token 使用率。
- 提示采用两档：
  - `60%`：一级提醒
  - `80%`：二级提醒，并说明即将 compact
- 在 hint 文案中写明：如果需要查看当前 context 分布，可以先调用 `show_context`。
- 同样的流程说明也应写入 System Prompt 的工具部分，因为模型也可能在没有经过 hint 的情况下主动 summarize。

状态与回写规则：

- 状态分为：
  - `none`
  - `level1_sent`
  - `level2_sent`
- 不希望频繁提醒、反复打断模型工作。
- 一级提醒发出后，如果没有 summarize，在触发二级提醒之前不再重复提醒。
- `summarize_context` 之后，不是简单按“是否调用过 summarize”重置状态，而是看它返回后的下一次 API 调用中真实返回的 `inputTokens`。
- 回写规则：
  - `< 40%` -> `none`
  - `>= 40% && < 65%` -> `level1_sent`
  - `>= 65%` -> 保持当前已发送等级（不降级，防止短时间内重复提醒）

Context ID 分组修正方向：

- 整个 turn 只有一轮纯文本回复：
  - assistant 回复继承 user message 的 ID
  - 二者共享同一 group
- 多轮工具调用 + 末尾纯文本：
  - 末尾文本继承最后一个 `tool_result` 的 ID
  - 和最后一个工具轮合为一组
- 多轮工具调用、无末尾文本（最后一轮就是工具调用）：
  - 无变化，保持现有行为
- 中断产生的 `assistant_text`：
  - 继承前面最近的 user-side ID

## 4. 长日志 / 大文件的默认阅读策略

这是后续 Prompt 和工具说明都应共享的一条推荐工作流：

- 不要直接阅读全文。
- 先搜索，再读取相关行。

对 shell log 的推荐工作流：

1. 如果有稳定日志路径，先用 `grep` 定位关键词。
2. 再用 `read_file(start_line, end_line)` 阅读局部。
3. 只有在确实需要整体结构时才扩大范围。

常见关键词示例：

- `error`
- `warn`
- `failed`
- `ready`
- `listening`
- 特定测试名 / 模块名 / 路径名

这条规则同样适用于：

- 大代码文件
- 长 Markdown 文档
- 文档投影生成的 Markdown
- 后台 shell 输出日志

## 5. 当前优先顺序

目前剩余设计项的推荐推进顺序：

1. Summarize hint 链路
2. `spawn_agent` / 未来 Agent Team 设计
3. compact prompt 与 toolcall 场景提示语改进

## 已完成

### A. `web_fetch`

当前实现方向：

- 默认优先走 Jina Reader 风格远程抽取。
- 当远程抽取失败时，自动回退到本地抽取。

当前实现边界：

- v1 不加入主动 rate limiter。
- v1 不加入 session 级缓存。
- 失败回退条件包括：
  - `403`
  - `429`
  - 超时
  - 网络错误
  - 明显异常或空结果

设计原则：

- 优先高质量正文抽取，以减少无效 token 消耗。
- 不把 SaaS quota 管理复杂度提前引入 v1。

### B. 文档投影 / MarkItDown

当前实现与边界：

- `pdf` / `docx` / `xlsx` 视为“可读取的文档投影视图”，而不是只在 `@file` 时才能处理的特殊附件。
- Agent 和用户继续围绕原始路径工作，例如 `report.pdf`。
- 系统内部可以把这些文件转换为 Markdown 并缓存，但不向 Agent 暴露 sidecar 路径。
- 当前覆盖：
  - `pdf`
  - `docx`
  - `xlsx`
- `pptx` 暂不支持。
- `html` 不进入这套自动文档投影，因为很多场景下需要的是原始 HTML 源码。

行为要求：

- `read_file("foo.pdf")` 返回 `foo.pdf` 的自动提取 Markdown 视图。
- 返回头需要让 Agent 知道这是提取文本视图，而不是版式级原貌。
- `@foo.pdf` 复用同一套文档投影逻辑。

### C. `apply_patch` v1

目标：

- 多处修改
- 结构化修改
- 大文件分块续写
- `edit_file` 需要多次精确替换才勉强完成的改动

与现有编辑工具的分工：

- `edit_file`
  - 单点、精确、小改动
  - 基于唯一 `old_str` 替换
- `write_file`
  - 创建文件
  - 一次性覆盖中小型文件
- `apply_patch`
  - 多 hunk 修改
  - 追加大文件
  - 复杂重构

第一阶段不删除 `edit_file`。

语法原则：

- 不直接暴露原始 `git diff` 给模型，而是使用更易生成、更易校验的 DSL。
- v1 支持：
  - `Update File`
  - `Append File`
  - `Add File`
  - `Delete File`
- v1 不支持：
  - `Move to`

原因：

- rename / move 不是当前最高优先级
- 有 `bash mv` 作为简单替代
- 去掉 `Move to` 可以降低 patch 语法复杂度

大文件写入策略：

- 大文件先用 `write_file` 写开头或骨架
- 然后用 `apply_patch` 的 `Append File` 分块追加

执行与安全要求：

- 先完整解析 patch
- 先完整校验，再开始写文件
- 如果校验失败，不写任何文件
- 文件写入继续复用现有：
  - `safePath`
  - file write lock
  - 原子写入

不承诺跨文件全局事务，但应保证：

- 匹配/校验阶段失败时无副作用

Prompt 行为要求：

- 小改动优先 `edit_file`
- 创建新文件优先 `write_file`
- 多处改动、复杂改动、大文件续写优先 `apply_patch`
- 大文件输出时：
  - 先 `write_file`
  - 再 `apply_patch` 分块追加

### D. 后台 shell 三件套

目标：

- dev server
- watcher
- 长时间测试
- 需要后续查看日志的脚本

当前工具集合：

- `bash_background(command, cwd?, id?)`
- `bash_output(id, tail_lines?, max_chars?)`
- `kill_shell(id, signal?)`

`bash_background`：

- 启动后台 shell
- 立即返回 shell id
- 不提供交互式 stdin
- Session 内跟踪状态：
  - `running`
  - `exited`
  - `failed`
  - `killed`
- 完整 stdout / stderr 写到稳定日志文件：
  - `{SESSION_ARTIFACTS}/shells/<id>.log`

`bash_output`：

- 读取后台 shell 的输出视图
- 默认返回最近输出或未读输出的受限窗口
- 底层完整日志不丢失，始终保留在 artifacts log file 中
- 如果输出过长，允许截断展示，但必须：
  - 保留少量开头或局部上下文
  - 明确写出截断提示
  - 告诉 Agent 去完整日志文件上继续搜索/阅读

`kill_shell`：

- 终止后台 shell
- 默认发送 `TERM`
- 可选更强信号

### E. `wait` / `check_status` 与 shell

当前结论：

- `wait` 支持后台 shell。
- 但只等待生命周期事件，不因普通输出而唤醒。

也就是：

- shell 退出
- shell 失败
- 新消息到来
- tracked worker 完成
- 超时

这些事件可以唤醒 `wait`。

普通 stdout/stderr 增长不应唤醒 `wait`，否则：

- watcher/dev server 会导致频繁唤醒
- `wait` 会失去意义

`check_status` 应逐步扩展为 tracked workers 总览，而不只关注 sub-agent。
