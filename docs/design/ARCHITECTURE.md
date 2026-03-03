# AquaClaw (雪蟹) Architecture Guide

This document outlines the architectural decisions that differentiate AquaClaw from its parent project, Nanoclaw.

## 1. High-Level Design Goals

*   **Transparency:** Every action taken by the AI must be visible to the developer in real-time.
*   **Isolation:** Each task must be physically separated from others to prevent cross-contamination of dependencies or environment variables.
*   **Observability:** Automated screenshots and diff summaries provide high-level status updates without requiring manual log review.
*   **Resilience:** The system must handle long-running tasks, network interruptions, and host reboots gracefully.

## 2. Core Components

### A. Discord Command Adapter (The Command Center)
Replaces the generic multi-channel message registry with a high-fidelity Discord-focused adapter.
*   **Command:** `/pincer [GitHub Issue URL]`
*   **Response Pattern:** Every new task creates a dedicated **Thread** in Discord. All logs, screenshots, and status updates are sent to this thread to keep the main channel clean.

### B. The Factory (`AcWorkspace`)
The physical engine that manages workspaces.
*   **Location:** `~/aquaclaw/factory/{thread_id}/`
*   **Workflow:** 
    1. Clone the repository into a unique directory.
    2. Manage independent `.envrc` and workspace-specific settings.
    3. Monitor directory for changes (using `chokidar` or similar).

### C. The Tmux Bridge (The Live Stream)
Encapsulates the Claude Agent SDK inside a persistent Tmux session.
*   **Purpose:** Allows the AI to persist even if the AquaClaw process restarts.
*   **Streaming:** Real-time stdout/stderr is piped from the Tmux session directly to the Discord thread.

### D. The Delta Feed (Gemini Powered Audit)
*   **Function:** Periodically (or upon file save/command completion) calculates the `git diff`.
*   **Logic:** Sends the diff to Gemini to generate a concise summary (e.g., "Modified login logic to handle null tokens").
*   **Visibility:** Sends the summary as a Discord rich card.

### E. Playwright Verification Loop
*   **Logic:** Before marking a task as "Ready for Review," AquaClaw automatically spins up a Playwright environment, runs UI tests, and sends "Before vs After" screenshots to the Discord thread.

## 3. Workflow Diagram

```
[Discord User] --(/pincer)--> [Bot Adapter]
                                    |
                            [AcWorkspace Factory]
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

*   **Host Lockdown:** AquaClaw is restricted to operating within `~/aquaclaw/factory/`.
*   **Port Isolation:** Each task is assigned a unique port (e.g., 3000-3050) via a `PortLocker` utility.
*   **Physical Isolation:** Unlike Docker containers which can sometimes mask performance or system-level issues on macOS (like keychain access or GPU acceleration), physical isolation ensures the AI is working on the real metal, which is critical for TiCOS.

---

*Last Updated: March 3, 2026*
