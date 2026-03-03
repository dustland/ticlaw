# 🦀 AquaClaw (雪蟹)

<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="AquaClaw" width="400">
</p>

<p align="center">
  <b>A Distributed AI R&D Engine for TiCOS.</b><br>
  Physically isolated, multi-channel commanded, and production-ready.
</p>

<p align="center">
  Forked from <a href="https://github.com/qwibitai/NanoClaw">Nanoclaw</a>
</p>

AquaClaw is a specialized evolution of Nanoclaw, redesigned to serve as the primary autonomous development engine for **TiCOS**. It transforms a Mac Mini (or any persistent host) into a 24/7 AI collaborator that bridges high-level requirements from Discord into physical code changes with industrial-grade monitoring.

## 🌊 The Vision

While Nanoclaw was built for personal assistance, **AquaClaw** is built for **Engineering Teams**. It focuses on:
- **Physical Workspace Isolation:** Every task gets its own physical directory "factory" and dedicated environment.
- **Discord-First Command & Control:** High-fidelity debugging, streaming logs, and thread-locked task management via Discord.
- **Deep Observability:** Automated snapshots, smart diff summaries, and Playwright-backed UI verification.
- **TiCOS Integration:** Native support for TiCOS development workflows and PR automation.

## 🛠 Core Capabilities

- **🦀 The Pincer (/pincer):** Grab any GitHub Issue URL from Discord, and AquaClaw automatically initializes a fresh, isolated workspace to solve it.
- **🏗 Physical Factory:** Unlike purely virtual containers, AquaClaw manages physical `~/aquaclaw/factory/{task_id}` directories, allowing for persistent toolchain access and easier manual intervention.
- **📺 Live Monitoring:** Real-time Tmux bridge streaming terminal output directly to Discord threads.
- **📸 Vision-Backed Audit:** Automated macOS screenshots for UI changes and Gemini-powered "Delta Feeds" for code summaries.
- **🚀 PR Pipeline:** Seamless transition from "Issue Solved" to "PR Created" with automated context-aware descriptions.

## 🚀 Quick Start (Development Mode)

```bash
git clone https://github.com/tiwater/aquaclaw.git
cd aquaclaw
npm install
# Setup environment variables in .env (AC_DISCORD_TOKEN, AC_GEMINI_API_KEY, etc.)
npm start
```

For the full setup guide, see [docs/SETUP.md](docs/SETUP.md).

## 🏗 Architecture

AquaClaw operates on a **Command -> Factory -> Relay** loop:

1.  **Command:** Discord Bot receives `/pincer [URL]`.
2.  **Factory:** A dedicated `AcWorkspace` is created. Tmux session starts.
3.  **Relay:** Logs, screenshots, and diffs are streamed back to the Discord thread.
4.  **Verification:** Playwright runs automated UI tests.
5.  **Delivery:** PR is submitted to GitHub.

Detailed design decisions are persisted in [docs/design/](docs/design/).

## 📜 Philosophy: "Small, Sharp, and Autonomous"

- **No Config Sprawl:** We use code-level customization. If you need new behavior, modify the engine.
- **Safety through Transparency:** You can see every command being run in real-time via the Discord/Tmux bridge.
- **Physical over Virtual:** While we support containers, we prefer physical isolation for R&D to avoid "container-in-container" toolchain headaches on macOS.

## 🤝 Contributing

We follow a **Skill-based contribution** model inherited from Nanoclaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

---

**AquaClaw** is a Tiwater project. Built with ❤️ for the future of TiCOS.
