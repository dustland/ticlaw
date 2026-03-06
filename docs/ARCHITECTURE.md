# TiClaw Architecture Guide

This document outlines the architectural decisions that differentiate TiClaw from its parent project, NanoClaw.

## 1. High-Level Design Goals

*   **Transparency:** Every action taken by the AI must be visible to the developer in real-time.
*   **Isolation:** Each task must be physically separated from others to prevent cross-contamination of dependencies or environment variables.
*   **Observability:** Automated screenshots and diff summaries provide high-level status updates without requiring manual log review.
*   **Resilience:** The system must handle long-running tasks, network interruptions, and host reboots gracefully.

## 2. Core Components

### A. Discord Command Adapter (The Command Center)
Replaces the generic multi-channel message registry with a high-fidelity Discord-focused adapter.
*   **Command:** `/claw [GitHub Issue URL]`
*   **Response Pattern:** Every new task creates a dedicated **Thread** in Discord. All logs, screenshots, and status updates are sent to this thread to keep the main channel clean.

### B. The Factory (`TcWorkspace`)
The physical engine that manages workspaces.
*   **Location:** `~/ticlaw/factory/{thread_id}/`
*   **Workflow:** 
    1. Clone the repository into a unique directory.
    2. Manage independent `.envrc` and workspace-specific settings.
    3. Monitor directory for changes (using `chokidar` or similar).

### C. The Multi-CLI Driver Pattern
To ensure flexibility and resilience against account-level issues, TiClaw abstracts the actual coding agent logic into a **Driver** pattern.
*   **Gemini Driver (Default):** Spawns the `gemini` CLI in non-interactive YOLO mode. It utilizes `--resume latest` to maintain state across turns and `stream-json` for real-time feedback.
*   **Claude Driver:** Utilizes the `@anthropic-ai/claude-agent-sdk` for deep integration with the AI coding CLI.
*   **Codex Driver:** A specialized driver for Codex-based workflows.
*   **Switching:** Controlled via the `TC_CODING_CLI` environment variable.

### D. The Tmux Bridge (The Live Stream)
Encapsulates the Claude Agent SDK inside a persistent Tmux session.
*   **Purpose:** Allows the AI to persist even if the TiClaw process restarts.
*   **Streaming:** Real-time stdout/stderr is piped from the Tmux session directly to the Discord thread.

### D. The Delta Feed (Gemini Powered Audit)
*   **Function:** Periodically (or upon file save/command completion) calculates the `git diff`.
*   **Logic:** Sends the diff to Gemini to generate a concise summary (e.g., "Modified login logic to handle null tokens").
*   **Visibility:** Sends the summary as a Discord rich card.

### E. Playwright Verification Loop
*   **Logic:** Before marking a task as "Ready for Review," TiClaw automatically spins up a Playwright environment, runs UI tests, and sends "Before vs After" screenshots to the Discord thread.

## 3. Workflow Diagram

```
[Discord User] --(/claw)--> [Bot Adapter]
                                    |
                            [TcWorkspace Factory]
                                    |
                            (mkdir + git clone)
                                    |
                            [Tmux Session (Claude)] <--- (Standard Input)
                                    |                           |
                            (Streaming Logs) -------------- [User Debugging]
                                    |
                            [Delta Feed/Screenshots]
                                    |
                            [PR Automation] --(gh pr create)--> [GitHub]
```

## 4. Key Security Decisions

*   **Host Lockdown:** TiClaw is restricted to operating within `~/ticlaw/factory/`.
*   **Port Isolation:** Each task is assigned a unique port (e.g., 3000-3050) via a `PortLocker` utility.
*   **Physical Isolation:** Unlike Docker containers which can sometimes mask performance or system-level issues on macOS (like keychain access or GPU acceleration), physical isolation ensures the AI is working on the real metal, which is critical for TiCOS.

---

*Last Updated: March 3, 2026*
