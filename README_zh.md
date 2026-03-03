# 🦀 AquaClaw (雪蟹)

<p align="center">
  <img src="assets/aquaclaw-logo.png" alt="AquaClaw" width="400">
</p>

<p align="center">
  <b>专为 TiCOS 打造的分布式 AI 研发引擎。</b><br>
  物理隔离、多渠道指挥、生产级就绪。
</p>

<p align="center">
  Fork 自 <a href="https://github.com/qwibitai/NanoClaw">Nanoclaw</a>
</p>

AquaClaw 是 Nanoclaw 的专业进化版，重新设计后作为 **TiCOS** 的核心自主开发引擎。它将 Mac Mini（或任何持久化主机）转变为一个 24/7 的 AI 协作节点，通过 Discord 将高层级需求桥接到物理代码变更，并具备工业级的监控能力。

## 🌊 愿景

Nanoclaw 是为个人助手而生，而 **AquaClaw** 是为**工程团队**打造的。它专注于：
- **物理工作区隔离：** 每个任务都拥有独立的物理目录“工厂（Factory）”和专用环境。
- **Discord 优先的指挥与控制：** 通过 Discord 线程锁定任务管理，提供高保真调试、流式日志。
- **深度可观测性：** 自动截图、智能 Diff 摘要以及基于 Playwright 的 UI 验证。
- **TiCOS 集成：** 原生支持 TiCOS 开发工作流和 PR 自动化。

## 🛠 核心能力

- **🦀 钳子 (/pincer):** 在 Discord 中抓取任何 GitHub Issue URL，AquaClaw 会自动初始化一个全新的、隔离的工作区来解决它。
- **🏗 物理工厂:** 不同于纯粹的虚拟容器，AquaClaw 管理物理的 `~/aquaclaw/factory/{task_id}` 目录，允许持久的工具链访问和更容易的人工干预。
- **📺 实时监控:** 通过 Discord 线程实时流式传输 Tmux 终端输出。
- **📸 视觉审计:** 针对 UI 变更的自动 macOS 截图，以及由 Gemini 驱动的“Delta Feeds”代码变更摘要。
- **🚀 PR 管道:** 从“问题解决”到“PR 创建”的无缝切换，具备自动化的上下文感知描述。

## 🚀 快速开始 (开发模式)

```bash
git clone https://github.com/tiwater/aquaclaw.git
cd aquaclaw
npm install
# 在 .env 中设置环境变量 (AC_DISCORD_TOKEN, AC_GEMINI_API_KEY 等)
npm start
```

完整安装指南请见 [docs/SETUP.md](docs/SETUP.md)。

## 🏗 架构

AquaClaw 运行在 **指挥 -> 工厂 -> 中继** 的循环中：

1.  **指挥:** Discord 机器人接收 `/pincer [URL]`。
2.  **工厂:** 创建专用的 `AcWorkspace`。启动 Tmux 会话。
3.  **中继:** 日志、截图和 Diff 实时传回 Discord 线程。
4.  **验证:** Playwright 运行自动化 UI 测试。
5.  **交付:** PR 提交至 GitHub。

详细的设计决策记录在 [docs/design/](docs/design/)。

## 📜 哲学：“短小精悍，自主运行”

- **无配置泛滥:** 我们使用代码级定制。如果你需要新行为，直接修改引擎。
- **透明即安全:** 你可以通过 Discord/Tmux 桥接实时查看运行的每一条命令。
- **物理优于虚拟:** 虽然我们支持容器，但在研发中我们更倾向于物理隔离，以避免 macOS 上的“容器套容器”工具链难题。

## 🤝 贡献

我们沿用了来自 Nanoclaw 的 **基于技能（Skill-based）的贡献** 模型。详情请见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

**AquaClaw** 是 Tiwater 的项目。为 TiCOS 的未来倾情打造 ❤️。
