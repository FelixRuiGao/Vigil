# Providers

## 1. 统一契约

所有 provider 都实现 `BaseProvider`，核心接口是：

- `sendMessage(messages, tools, options)`
- `asyncSendMessage(...)`
- `requiresAlternatingRoles`
- `budgetCalcMode`

统一返回 `ProviderResponse`，包含：

- `text`
- `toolCalls`
- `usage`
- `reasoningContent`
- `reasoningState`
- `citations`
- `extra`

原因：

- Session 和 tool loop 不应该理解各家 API 的响应细节
- reasoning、tool calls、usage 只有先归一化，才能安全写入统一日志

## 2. Provider 输入

provider 接收的是 API 投影层产物，不是原始日志。

在进入 provider 之前，系统已经完成：

- compact window 选择
- assistant round 组合
- tool result 拆分
- 图片块解析
- 连续同 role 合并

provider 只负责把统一消息格式转换成各家 API 所需格式。

## 3. 当前实现

- `anthropic.ts`
  - Anthropic Messages API
  - 支持显式 prompt caching 标记和严格 role alternation
- `openai-responses.ts`
  - OpenAI Responses API
  - 更贴近 GPT-5 系列能力模型
- `openai-chat.ts`
  - OpenAI-compatible Chat Completions
  - 负责最广泛的兼容层和流式 tool args 组装
- `kimi.ts`
  - Moonshot / Kimi 适配
- `glm.ts`
  - Zhipu / GLM 适配
- `minimax.ts`
  - MiniMax 适配
- `openrouter.ts`
  - OpenRouter 网关适配

## 4. 重要差异

### role alternation

部分 provider 要求严格 user / assistant 交替；这通过 `requiresAlternatingRoles` 告诉投影层，而不是改写事实日志。

### token budget

不同 provider 对 compact 预算的计算方式不同；这通过 `budgetCalcMode` 暴露给运行时。

### reasoning 与 citations

各家 API 返回 reasoning 和 citation 的形态不同，但 provider 层会统一归一化到 `ProviderResponse`。

### web search 与 caching

是否支持原生 web search、如何暴露 cache 命中、是否需要额外参数，都是 provider 层处理的差异，不上浮到 Session。

## 5. 为什么这些差异留在 provider 层

- HTTP 头、请求 schema、流式 chunk 结构都强依赖厂商
- 把差异隔离在 provider 层，运行时才能保持“日志 + 编排”这一条主线
