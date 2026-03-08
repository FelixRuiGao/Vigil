# Message Architecture

## 1. 事实层与发送层分离

LongerAgent 不把 provider message history 当作事实存储。

当前消息模型分成两层：

- 事实层：`Session._log` + `_messageQueue`
- 发送层：`projectToApiMessages()` 生成的 provider 输入

原因：

- provider message 序列只是某一时刻的发送格式
- 运行时还需要表达“尚未投递”“已被 summary 替换”“已被 compact 折叠”等状态，这些都不适合直接存进 provider message 数组

## 2. 运行时消息来源

Session 接收三类外部消息：

- user input
- system notifications
- sub-agent results

这些消息不会立刻变成 provider message；它们先进入 Session 的统一运行时模型。

## 3. 统一表示方式

当前统一表示是：

- 已进入当前上下文的内容写入 `_log`
- 尚未被当前 activation 消费的外部消息进入 `_messageQueue`
- sub-agent 的运行过程保存在其临时日志中，最终结果再投递回主会话日志

原因：

- 系统需要区分“已经成为上下文的事实”和“等待投递的外部状态”
- 这种区分对 `wait`、`check_status`、activation boundary drain 都很关键

## 4. 内容形态

日志里的 `content` 不是 provider 私有格式，而是稳定的内部内容表示。

当前会出现几种典型形态：

- 纯文本字符串
- 多模态内容数组
- `image_ref` 引用
- tool call / tool result 的结构化内容

在发送给 provider 之前，投影层才会把这些内容转换成各家 API 需要的块结构。

## 5. Round 语义

同一 provider round 在日志里会拆成多个条目：

- `reasoning`
- `assistant_text`
- `tool_call`
- `tool_result`

然后在 API 投影阶段按 round 重新组合成 assistant / tool message。

原因：

- 日志需要保留流式事件边界
- provider 需要的是协议完整、角色正确的消息序列

## 6. important log 与图片

important log 和图片都不直接以 provider 发送格式存储：

- important log 在 API 投影时注入
- 图片在日志中以 `image_ref` 表示，发送时再解析为具体图片块

原因：

- 事实层应尽量轻量、稳定、可持久化
- provider 兼容转换必须集中在投影层处理
