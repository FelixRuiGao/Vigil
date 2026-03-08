# Message Delivery

## 1. 统一投递入口

所有外部消息统一走 `_deliverMessage(source, content)`。

当前 `source` 包括：

- `user`
- `system`
- `sub-agent`

原因：

- user、system、sub-agent 不应各自维护一套投递规则
- 统一入口后，消息顺序、保存和恢复逻辑都更容易验证

## 2. 按 Agent 状态处理

### `idle`

- 直接注入日志
- 下一次 provider 调用自然会看到这些消息

### `working`

- 进入 `_messageQueue`
- 等待 notification 或 activation boundary drain 投递

### `waiting`

- 进入 `_messageQueue`
- 立即唤醒 `wait`

原因：

- 中途插入 provider message 会破坏工具协议和 round 结构
- 通过队列延迟投递，可以保持日志顺序和 provider 协议稳定

## 3. 两条投递路径

### tool-result notification

当 agent 正在工具循环中时，Session 可以把“有新消息/有新 agent 状态”压缩成 notification，附加到本轮工具结果里。

### activation boundary drain

当一次 activation 返回后，Session 检查：

- `_messageQueue`
- 未投递的 sub-agent 最终结果

只要有内容，就把它们写入日志并启动下一次 activation。

原因：

- notification 适合尽快提醒模型“外面发生了新事”
- boundary drain 负责兜底，保证纯文本输出、wait 返回、sub-agent 完成后消息都不会丢

## 4. `check_status` 与 `wait`

- `check_status`
  - 主动拉取当前新消息和 sub-agent 状态
- `wait`
  - 阻塞到超时、消息到达或 agent 完成

这两个工具读的是同一套待投递状态，不额外维护第二份队列。

## 5. 为什么不做“中途插入 user message”

LongerAgent 不尝试把新的 user message 直接插进 provider 正在处理的消息流。

原因：

- 这会破坏 provider 的 tool-call / tool-result 协议边界
- 也会让日志顺序和 provider 看到的上下文不一致
- 统一走队列和 activation boundary，更容易恢复和调试
