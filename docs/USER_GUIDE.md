# 🦀 TiClaw User Guide

Welcome to TiClaw, your distributed AI R&D engine. This guide explains how to use the system to automate your development workflows via Discord.

---

## 🚀 Getting Started

### 1. Engine Initialization
Before the AI can work, the engine must be running on your host machine (e.g., Mac Mini):

```bash
pnpm install
pnpm run build
pnpm start
```
*Look for `Discord bot connected` in the terminal.*

### 2. Environment Prerequisites
Ensure your `.env` is configured with:
- `TC_DISCORD_TOKEN`: Your bot token.
- `OPENROUTER_API_KEY`: For LLM access.
- `TC_CODING_CLI`: Set to `"gemini"` (default) or `"claude"`.
- `HTTPS_PROXY`: (Optional) If you are in a region with restricted access.

### 3. Repository Environment Seeding (Optional but Recommended)
To automate the creation of `.env` files for the projects TiClaw works on:
1. Create a directory: `config/environments/`.
2. Add `.env` files named after your repositories (e.g., `ticos.env` for `tiwater/ticos`).
3. TiClaw will automatically copy this file into the workspace during the `/claw` phase.

---

## 🛠 Command Reference

TiClaw is commanded entirely through **Discord**. All task-specific commands should be run within the **Thread** created for that task.

### 🦀 `/claw [GitHub Issue URL]`
**Usage:** Start a new research or development task.
- **What it does:** 
  1. Creates a dedicated Discord Thread.
  2. Creates a physical workspace at `~/ticlaw/factory/{thread_id}`.
  3. Clones the repository.
  4. Starts a persistent Tmux session for the AI.
- **Example:** `/claw https://github.com/user/repo/issues/42`

### 📸 `/verify [URL]`
**Usage:** Trigger an automated UI verification.
- **What it does:** 
  1. Spins up a headless Playwright browser.
  2. Navigates to the provided URL.
  3. Captures a full-page screenshot.
  4. Automatically uploads the screenshot to the Discord thread.
- **Example:** `/verify http://localhost:3000`

### 🛠 `/skill [skill-name]`
**Usage:** Inject specialized capabilities into the active workspace.
- **What it does:** Applies an OpenClaw skill (found in `skills/`) to the current physical factory.
- **Example:** `/skill add-slack`

### 🚀 `/push`
**Usage:** Finalize the task and submit your work.
- **What it does:** 
  1. Summarizes all code changes using Gemini.
  2. Collects the Discord thread history for context.
  3. Uses the GitHub CLI (`gh`) to create a Pull Request with an AI-generated description.
- **Pro Tip:** We strongly recommend enabling **Live Preview Environments** (e.g., via **Render.com** or **Vercel**) on your target repository.
  - If you configure `TC_PREVIEW_URL_PATTERN` in your `.env` (e.g., `https://myapp-pr-${PR_NUMBER}.onrender.com`), TiClaw will automatically relay the live deployment URL to your Discord thread upon creating the PR.

---

## 📺 Monitoring & Observability

TiClaw provides three layers of "Live Monitoring":

1.  **The Delta Feed:** Every time the AI modifies a file, a Gemini-powered summary (e.g., *"Modified auth logic to support JWT"*) is posted to the Discord thread.
2.  **Live Snapshots:** If the AI is working on UI, it may automatically trigger snapshots that appear in the thread.
3.  **Tmux Bridge (Terminal):** On the host machine, you can attach to the live session at any time:
    ```bash
    tmux attach -t tc-{thread_id}
    ```

---

## 🛡 Security & Best Practices

- **Physical Isolation:** Each task is isolated in its own folder. TiClaw will never touch files outside of `~/ticlaw/factory/`.
- **Port Locking:** If your task starts a web server, TiClaw assigns a unique port (3000-3050) to prevent conflicts.
- **Review Before Merge:** Always review the AI-generated PR before merging. Use the automated Playwright screenshots to verify UI changes visually from your phone or desktop Discord app.

---

*TiClaw: Autonomous R&D for the modern engineering team.*
