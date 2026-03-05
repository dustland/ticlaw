# 🦀 TiClaw

<p align="center">
  <img src="assets/ticlaw-logo.png" alt="TiClaw" width="400">
</p>

<p align="center">
  <b>专为工程团队打造的分布式 AI 研发引擎。</b><br>
  物理隔离、多渠道指挥、生产级就绪。
</p>

<p align="center">
  Fork 自 <a href="https://github.com/qwibitai/nanoclaw">NanoClaw</a>
</p>

TiClaw 是 NanoClaw 的专业进化版，重新设计后作为工程团队的核心自主开发引擎。它将 Mac Mini（或任何持久化主机）转变为一个 24/7 的 AI 协作节点，通过 Discord 将高层级需求桥接到物理代码变更，并具备工业级的监控能力。

## 🌊 愿景

NanoClaw 是为个人助手而生，而 **TiClaw** 是为**工程团队**打造的。它专注于：
- **物理工作区隔离：** 每个任务都拥有独立的物理目录“工厂（Factory）”和专用环境。
- **Discord 优先的指挥与控制：** 通过 Discord 线程锁定任务管理，提供高保真调试、流式日志。
- **深度可观测性：** 自动截图、智能 Diff 摘要以及基于 Playwright 的 UI 验证。
- **💻 多 CLI 支持：** 可在 **Gemini CLI (默认)**、Claude Code 和 Codex 之间无缝切换，确保研发工作的持续性。

## 🛠 核心能力

- **🦀 钳子 (/claw):** 在 Discord 中抓取任何 GitHub Issue URL，TiClaw 会自动初始化一个全新的、隔离的工作区来解决它。
- **🏗 物理工厂:** 不同于纯粹的虚拟容器，TiClaw 管理物理的 `~/ticlaw/factory/{task_id}` 目录，允许持久的工具链访问和更容易的人工干预。
- **📺 实时监控:** 通过 Discord 线程实时流式传输 Tmux 终端输出。
- **📸 视觉审计:** 针对 UI 变更的自动 macOS 截图，以及由 Gemini 驱动的“Delta Feeds”代码变更摘要。
- **🚀 PR 管道:** 从“问题解决”到“PR 创建”的无缝切换，具备自动化的上下文感知描述。

## 🚀 快速开始 (开发模式)

```bash
git clone https://github.com/dustland/ticlaw.git
cd ticlaw
pnpm install
# 在 .env 中设置环境变量 (TC_DISCORD_TOKEN, TC_GEMINI_API_KEY 等)
pnpm start
```

## 我们为什么构建 TiClaw

TiClaw 扩展了 [NanoClaw](https://github.com/qwibitai/nanoclaw) 的设计哲学，为专业的 AI 开发提供真实的隔离和工业级的监控。NanoClaw 专注于轻量级个人智能体，而 TiClaw 则针对团队环境进行了优化，在这种环境下，透明度和可靠性是不可逾越的底线。

## 设计哲学

**默认透明：** 每一个 Shell 命令和日志都是实时流式传输的。不存在 AI 的“黑盒”操作。

**物理优于虚拟：** 虽然我们支持容器隔离，但在研发中我们更倾向于物理目录隔离，以确保原生性能，并能在需要时完全访问系统级工具（GPU、Keychain 等）。

**定制即代码修改：** 无配置泛滥。如果你需要不同的行为，直接修改 TiClaw 引擎代码。

## 系统要求

- macOS (专为 Mac Mini 优化) 或 Linux
- Node.js 20+
- [Gemini CLI](https://github.com/google/gemini) (默认) 或 [Claude Code](https://claude.ai/download)
- [Discord 机器人 Token](https://discord.com/developers/applications)

## 架构

TiClaw 运行在 **指挥 -> 工厂 -> 中继** 的循环中：

1.  **指挥:** Discord 机器人接收 `/claw [URL]`。
2.  **工厂:** 创建专用的 `TcWorkspace`。启动 Tmux 会话。
3.  **中继:** 日志、截图和 Diff 实时传回 Discord 线程。
4.  **验证:** Playwright 运行自动化 UI 测试。
5.  **交付:** PR 提交至 GitHub。

有关如何操作系统的完整指南，请参阅 [用户指南 (User Guide)](docs/USER_GUIDE.md)。

## 常见问题

**为什么要用 Tmux 而不仅仅是容器？**

Tmux 允许持久化会话，可以手动挂载进行调试。它提供了纯容器日志有时会缺失的可观测性，特别是对于交互式 CLI 工具。

**我可以切换 Gemini 和 Claude 吗？**

可以。在 `.env` 中设置 `TC_CODING_CLI="claude"` 或 `TC_CODING_CLI="gemini"` 即可。

**这安全吗？**

TiClaw 使用物理隔离和端口锁定。然而，它是为受控的研发环境设计的。请始终审查代码更改，并使用专用的开发机器（如 Mac Mini）。

**我可以用于其他项目吗？**

当然！TiClaw 的 `/claw` 和工厂逻辑适用于任何托管在 GitHub 上的项目。

**我可以使用第三方 LLM 供应商吗？**

是的！TiClaw 默认使用 **OpenRouter**，它通过兼容 Anthropic 的 API 提供对 Claude 3.5 Sonnet 和其他强大模型的访问。你可以通过更新 `.env` 文件切换到原生的 Anthropic 或 Gemini。

## 致谢 (Credits)

TiClaw 自豪地构建在 **[NanoClaw](https://github.com/qwibitai/nanoclaw)** 的基础之上。我们保留了 NanoClaw 核心的消息路由和任务调度逻辑，同时通过研发特定的功能对其进行了扩展。
