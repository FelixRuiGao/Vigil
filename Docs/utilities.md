# Utilities and Support Modules

## 1. Persistence

`src/persistence.ts` 负责 log-native 持久化：

- `SessionStore`
- `saveLog()`
- `loadLog()`
- `validateAndRepairLog()`
- `archiveWindow()` / `loadArchive()` / `restoreArchiveToEntries()`

原因：

- 持久化只保留一种格式，恢复路径才能保持简单
- archive 把旧窗口的重量级内容移出 active log，长会话仍然可恢复

## 2. File Attach

`src/file-attach.ts` 负责：

- `@file` 引用解析
- 文本文件注入
- 图片识别与多模态内容生成

原因：

- 附件语义需要在进入 provider 前统一规范化
- Session 只处理整理好的内容块，不负责重新解析原始输入语法

## 3. Security

### `src/security/path.ts`

- 路径边界校验
- symlink 逃逸检测
- 不同 access kind 的统一安全入口

### `src/security/sensitive-files.ts`

- 敏感文件读取规则
- `.env`、credential、私钥类文件的额外限制

原因：

- 文件工具是最高风险入口
- 安全策略需要独立于具体工具执行器，避免遗漏

## 4. Network Retry

`src/network-retry.ts` 负责：

- retryable 错误识别
- 指数退避时间计算
- sleep helper

原因：

- provider 网络失败是正常情况
- retry 策略应统一，而不是散落在 provider 或 Session 的分支里

## 5. Templates

`src/templates/loader.ts` 从目录加载 agent template：

- `agent.yaml`
- `system_prompt.md`

loader 会把模板解析成运行时 `Agent` 定义，包括工具列表和模型配置。

## 6. Skills

`src/skills/loader.ts` 负责加载本地 skills：

- 元数据
- 正文内容
- `disableModelInvocation` 等约束

这些内容会被 `Session` 组合成动态 `skill` 工具。

## 7. MCP Client

`src/mcp-client.ts` 负责外部 MCP server 的连接、调用和安全包装。

原因：

- MCP 是运行时外部能力入口
- 连接与调用细节应独立于 Session 主编排逻辑
