<p align="center">
  <img src="https://raw.githubusercontent.com/FelixRuiGao/LongerAgent/main/assets/logo.png" alt="LongerAgent" width="360" />
</p>
<p align="center">
  <strong>为长时间会话而生的终端 AI 编程助手。</strong>
</p>
<p align="center">
  <a href="./README.md">English</a> | 中文
</p>
<p align="center">
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-blue?style=flat-square&logo=typescript&logoColor=white" />
  <img alt="Author" src="https://img.shields.io/badge/author-Felix%20Rui%20Gao-4b4bf0?style=flat-square" />
</p>

大多数 AI 助手在长对话中会崩溃、循环或悄悄丢失上下文。LongerAgent 从底层为长时间会话而设计——结构化日志架构、三层上下文管理、跨会话持久记忆。

![LongerAgent Terminal UI](https://raw.githubusercontent.com/FelixRuiGao/LongerAgent/main/assets/screenshot.png)

https://github.com/user-attachments/assets/377fe648-d43c-45da-b111-9434b2a0dc61

> **平台：** macOS。Windows 未经测试。
>
> **安全：** LongerAgent 不对命令做沙盒隔离，也不会在文件编辑和 Shell 执行前要求审批。请在可信环境中使用，并留意它的操作。

## 快速开始

```bash
# 全局安装
npm install -g longer-agent

# 运行配置向导（创建 ~/.longeragent/config.yaml）
longeragent init

# 启动
longeragent
```

---

## 亮点

- **三层上下文管理** —— 会话越来越长，也不怕
- **并行子 Agent** —— 通过 YAML 调用文件 spawn 多个 worker 并发执行
- **Skills 系统** —— 自主搜索、安装和管理可复用的技能包
- **持久记忆** —— `AGENTS.md` 和 Important Log 跨会话、跨压缩存续
- **异步消息** —— Agent 工作中随时发送消息，不用等它完成
- **7 大 Provider** —— Anthropic、OpenAI、Kimi、MiniMax、GLM、OpenRouter，以及任何 OpenRouter 兼容模型

## 使用

### 上下文管理

Agent 会自动管理上下文，你也可以手动介入：

```text
/summarize                                # 压缩较早的上下文片段
/summarize 保留认证重构的细节               # 带指令的压缩
/compact                                  # 全量上下文重置，附带延续摘要
/compact 保留数据库 Schema 的决策           # 带指令的重置
```

`/summarize` 会精确压缩选定的片段，同时保留关键决策——适合上下文在增长但还不需要全量重置的时候。`/compact` 是终极手段：全量重置，生成延续摘要，Agent 从中断处继续。

Agent 也可以通过 `show_context` 和 `summarize_context` 工具自主完成以上操作——无需用户干预。

会话全程维护一份 **Important Log**——关键发现、失败的尝试、架构决策都会写入其中，在每次压缩后依然保留。

### 子 Agent

让 Agent 自行 spawn 子 Agent，或通过 YAML 调用文件定义任务：

```yaml
# tasks.yaml
tasks:
  - name: research
    template: explorer
    prompt: "调查这个代码库中认证模块的工作方式"
  - name: refactor
    template: executor
    prompt: "将所有旧版 API 端点重命名为 v2"
```

三个内置模板：**main**（全部工具）、**explorer**（只读）、**executor**（任务执行）。子 Agent 并发运行，完成后汇报结果。

### Skills

Skills 是可按需加载的可复用工具定义。

```text
你：   "安装 skill: apple-notes"          # Agent 使用内置 skill-manager
你：   /skills                            # 勾选启用/禁用
```

自定义 skill：在 `~/.longeragent/skills/<name>/` 下添加 `SKILL.md` 即可。

### 持久记忆

每轮对话自动加载两个 `AGENTS.md` 文件：

- **`~/AGENTS.md`** —— 所有项目通用的全局偏好
- **`<project>/AGENTS.md`** —— 项目级的架构笔记和模式

Agent 读取它们获取背景信息，也可以写入以保存长期知识。跨会话和上下文重置持久存在。

### 异步消息

随时输入消息——即使 Agent 正在工作。消息会排队，在下一个激活边界送达。

<details>
<summary><strong>上下文管理机制详解</strong></summary>

三层机制协同工作，控制上下文：

1. **提示压缩** —— 随着上下文增长，系统提示 Agent 主动压缩较早的片段
2. **Agent 主导的压缩** —— Agent 通过 `show_context` 检查上下文分布，用 `summarize_context` 精确压缩选定片段，保留关键决策和未解决的问题
3. **自动压缩** —— 接近上限时，系统执行全量上下文重置并生成延续摘要——Agent 从中断处继续

</details>

## 支持的 Provider

| Provider | 模型 | 环境变量 |
|----------|------|----------|
| **Anthropic** | Claude Haiku 4.5、Opus 4.6、Sonnet 4.6（含 1M 上下文变体） | `ANTHROPIC_API_KEY` |
| **OpenAI** | GPT-5.2、GPT-5.2 Codex、GPT-5.3 Codex、GPT-5.4 | `OPENAI_API_KEY` 或 OAuth |
| **Kimi / Moonshot** | Kimi K2.5、K2 Instruct（国际、国内、Coding Plan） | `KIMI_CN_API_KEY` / `KIMI_API_KEY` |
| **MiniMax** | M2.1、M2.5（国际、国内） | `MINIMAX_API_KEY` |
| **GLM / 智谱** | GLM-5、GLM-4.7（国际、国内、Coding Plan） | `GLM_API_KEY` |
| **OpenRouter** | Claude、GPT、Kimi、MiniMax、GLM 预设，及任意自定义模型 | `OPENROUTER_API_KEY` |

## 工具

**15 个内置工具：**

`read_file` · `list_dir` · `glob` · `grep` · `edit_file` · `write_file` · `apply_patch` · `bash` · `bash_background` · `bash_output` · `kill_shell` · `diff` · `test` · `web_search` · `web_fetch`

`read_file` 在多模态模型上支持图片文件（PNG、JPG、GIF、WebP 等）——Agent 可以直接查看和分析图片。

**8 个编排工具：**

`spawn_agent` · `kill_agent` · `check_status` · `wait` · `show_context` · `summarize_context` · `ask` · `plan`

**Skills 系统** —— 将可复用的技能定义加载为动态 `skill` 工具。通过 `/skills` 管理（勾选启用/禁用），`reload_skills` 热重载。内置 `skill-manager` 可教 Agent 自主搜索、下载和安装新技能。

**MCP 集成** —— 连接 Model Context Protocol 服务器以扩展工具。

## 斜杠命令

| 命令 | 说明 |
|------|------|
| `/model` | 运行时切换已配置的模型 |
| `/thinking` | 控制每个模型的思考/推理深度 |
| `/skills` | 勾选启用/禁用技能 |
| `/resume` | 从日志恢复之前的会话 |
| `/summarize` | 压缩较早的上下文片段以释放空间 |
| `/compact` | 全量上下文重置，附带延续摘要 |

## 配置

LongerAgent 从安装包加载内置默认值，从 `~/.longeragent/` 加载用户覆盖。
`longeragent init` 会创建 `config.yaml` 及空的覆盖目录。

```text
~/.longeragent/
├── config.yaml            # 模型和 Provider 配置（由 init 创建）
├── settings.json          # 运行时调优（可选）
├── tui-preferences.json   # TUI 状态自动保存
├── agent_templates/       # 用户模板覆盖
├── skills/                # 用户技能
└── prompts/               # 用户 Prompt 覆盖
```

参见 [configExample.yaml](./configExample.yaml) 获取配置参考。

### 运行时设置（`settings.json`）

```jsonc
{
  // 覆盖最大输出 token 数（限制在 [4096, 模型最大值]）
  "max_output_tokens": 32000,
  // 上下文管理阈值（有效上下文的百分比，20-95）
  "context": {
    "summarize_hint_level1": 60,
    "summarize_hint_level2": 80,
    "compact_output": 85,
    "compact_toolcall": 90
  }
}
```

## 架构

LongerAgent 围绕 **Session → Agent → Provider** 流水线构建：

- **Session** 编排 turn 循环、消息投递、压缩、子 Agent 生命周期
- **Session Log** 是唯一事实来源——20+ 种条目类型记录所有运行时事件；TUI 显示和 Provider 输入都是同一数据的投影
- **Agent** 将模型 + 系统 Prompt + 工具封装为可复用的执行单元
- **Provider** 适配器在 7 个 Provider 家族间统一流式输出、推理、工具调用和用量

## CLI 选项

```text
longeragent                     # 使用自动检测的配置启动
longeragent init                # 运行配置向导
longeragent oauth               # 通过 OAuth 登录 OpenAI（设备码 / 浏览器）
longeragent oauth status        # 查看 OAuth 登录状态
longeragent oauth logout        # 登出
longeragent --config <path>     # 使用指定配置文件
longeragent --templates <path>  # 使用指定模板目录
longeragent --verbose           # 启用调试日志
```

## 开发

```bash
pnpm install        # 安装依赖
pnpm dev            # 开发模式（自动重载）
pnpm build          # 构建
pnpm test           # 运行测试（vitest）
pnpm typecheck      # 类型检查
```

## 许可证

[MIT](./LICENSE)
