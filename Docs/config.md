# Configuration

## 1. 配置的职责

配置系统负责三类信息：

- model definitions
- 路径占位和默认目录
- MCP server definitions

`src/config.ts` 会把 YAML 配置解析成运行时可直接使用的结构。

## 2. ModelConfig

每个模型最终都会被规范化成 `ModelConfig`，包含：

- provider
- model
- apiKey
- baseUrl
- temperature
- maxTokens
- contextLength
- supportsMultimodal
- supportsThinking
- thinkingBudget
- supportsWebSearch
- extra

原因：

- provider 层需要的是完整、显式的配置对象
- 能力推断应该在启动时完成，而不是分散到 Session 和 TUI 里临时猜测

## 3. 能力推断

`config.ts` 内置了常见模型的能力表和推断逻辑，例如：

- context length
- multimodal 支持
- thinking 支持与级别
- native web search 支持

同时允许显式覆盖。

原因：

- 大多数配置可以更短
- 运行时可以依赖“已规范化能力”，而不是到处写 provider 特判

## 4. 路径占位

系统 prompt 和模板中可使用这些路径占位：

- `{PROJECT_ROOT}`
- `{SESSION_ARTIFACTS}`
- `{SYSTEM_DATA}`

`Session` 会在初始化时渲染这些路径。

原因：

- prompt 需要稳定引用工作区和会话目录
- 路径解析必须集中管理，不能散落在工具实现里硬编码

## 5. MCP 配置

MCP server 配置描述：

- transport
- command / args 或 url
- env
- envAllowlist
- sensitiveTools

原因：

- MCP 是外部工具扩展入口
- 哪些环境变量可以暴露、哪些工具属于高风险，必须由配置显式声明
