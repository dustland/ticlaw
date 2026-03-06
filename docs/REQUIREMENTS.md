# TiClaw Requirements & Philosophy

This document outlines the foundational requirements and engineering principles for TiClaw — a distributed AI R&D engine designed as a black-box core with a plugin ecosystem.

---

## 🎯 The Mission: Professional R&D Engine

TiClaw is designed to be a **Distributed AI R&D Engine**. It transforms local hardware into an autonomous, transparent, and persistent AI collaborator capable of executing real-world engineering tasks.

---

## 📜 Core Philosophy

### 1. Small Enough to Understand (Clean Architecture)
The codebase must remain readable by a single senior engineer. We avoid unnecessary abstraction layers. Logic flows linearly: **Request -> Factory -> Execution -> Relay**.

### 2. Black-Box Core + Plugin Ecosystem
The engine core is a **closed, installable package** (`npm install -g ticlaw`). Users never modify engine source code. Extensibility is achieved through:
- **Channel plugins** — npm packages that implement the `Channel` interface (e.g., `@ticlaw/channel-discord`, `@ticlaw/channel-telegram`)
- **CLI drivers** — pluggable agent backends (Gemini CLI, Claude Code, Codex)
- **Configuration files** — not code changes

This enables clean upgrades (`npm update ticlaw`), broad adoption, and a healthy ecosystem.

### 3. Physical-First Isolation
While we support containers for generic tasks, TiClaw prioritizes **Physical Workspace Isolation**.
- Every task lives in a dedicated directory: `~/ticlaw/factory/{id}`.
- This provides the AI native access to host toolchains (Node, Go, Rust, etc.) while preventing cross-task contamination.

### 4. Channel-Agnostic Control Plane
The core engine treats communication platforms (Discord, Slack, etc.) as **Adapters**.
- The engine provides generic hooks for commands (`/claw`, `/push`, `/verify`) and relays (logs, screenshots, summaries).
- **Discord** serves as our primary reference implementation for high-fidelity R&D workflows (using threads for context isolation and rich media for audits).

### 5. Multi-CLI Driver Pattern
To ensure provider resilience, the coding agent logic is abstracted into a **Driver Pattern**:
- **Gemini CLI (Default):** For leveraging personal subscriptions and high-speed execution.
- **Claude Code:** For deep integration with Anthropic's agentic SDK.
- **Programmatic ADK:** For API-based scaling.

---

## 🛠 Functional Requirements

### A. Automated Workspace "The Factory"
- **Workspace Orchestration:** A standardized flow to clone, branch, and bootstrap any GitHub repository.
- **Environment Seeding:** Granular, recursive `.env` seeding from `~/ticlaw/config/environments/` to support complex monorepos.
- **Auto-Bootstrap:** Automatic detection and execution of project-specific setup scripts and package managers.

### B. Deep Observability (The Audit Trail)
- **The Delta Feed:** An engine-level event that generates Gemini-powered "Plain English" summaries of code changes.
- **Artifact Relay:** Automated mechanism to push screenshots and terminal logs back to the control channel.
- **Persistent Sessions:** Every session must be manageable via Tmux to allow for manual human-in-the-loop intervention.

### C. Verification & Delivery
- **UI Verification Loop:** Integrated browser automation (Playwright) within the physical factory for visual audits.
- **PR Automation:** Pipeline to finalize tasks by creating GitHub Pull Requests with context-aware descriptions derived from the Git Diff and conversation history.
- **Live Preview Environments:** We strongly recommend integrating branch-based deployment platforms (e.g., **Render.com**, **Vercel**, **Railway**) into the project's CI/CD. This allows the AI-generated PR to be accompanied by a live, shareable URL for manual stakeholder verification.

---

## 🏗 Architectural Guidelines

### Skills-Based Extensibility

The engine extends through **skills** — self-contained packages that combine agent instructions (SKILL.md) with implementation code:

| Extension Point | Mechanism | Example |
|----------------|-----------|---------|
| **Channels** | Skill with `Channel` implementation | `skills/add-discord/` — adds Discord connectivity |
| **CLI Drivers** | Config (`TC_CODING_CLI`) | `TC_CODING_CLI=gemini` switches the agent backend |
| **MCP Tools** | Standard MCP config | MCP server discovery and tool calling |

Skills are the primary extensibility mechanism. Adding a new channel means creating a skill that provides a `Channel` implementation, handles credential setup, and self-registers at startup.

### Data Decentralization
All transient data, databases, and logs must reside in **`~/ticlaw/`**, keeping the source repository strictly for engine logic.

---

*TiClaw: Built for the future of autonomous engineering teams.*
