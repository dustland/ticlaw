# 🦀 AquaClaw (雪蟹) Phase-by-Phase Work Plan

This document serves as the master execution plan for converting NanoClaw into AquaClaw.

---

## Phase 1: Foundation - The Command & Factory Core (Week 1)

### 1.1 Discord Bridge Implementation
*   **Goal:** Replace the legacy multi-channel system with a high-fidelity Discord adapter.
*   **Tasks:**
    *   Initialize `discord.js` client.
    *   Implement `/claw [GitHub URL]` command.
    *   Implement automated Discord thread creation for each task.
    *   **Success Metric:** A GitHub URL sent via Discord results in a new thread and a confirmation message.

### 1.2 Physical Workspace Factory
*   **Goal:** Move from temporary directories to persistent, isolated factory environments.
*   **Tasks:**
    *   Implement `AcWorkspace` class to manage `~/aquaclaw/factory/`.
    *   Implement `PortLocker` to assign unique ports (3000-3050) per task.
    *   Setup automated `git clone` and dependency installation within the factory.
    *   **Success Metric:** Each task lives in its own directory with no port conflicts.

### 1.3 Tmux Encapsulation & Streaming
*   **Goal:** Ensure persistence and live observability.
*   **Tasks:**
    *   Implement Tmux session creation via Node.js.
    *   Pipe Tmux stdout/stderr to the Discord thread.
    *   Implement a "Re-attach" mechanism if the process restarts.
    *   **Success Metric:** Live terminal logs appear in Discord threads.

---

## Phase 2: Monitoring & Quality - The "Observability" Layer (Week 2)

### 2.1 The Screenshot Skill
*   **Goal:** Provide visual status updates for UI-related changes.
*   **Tasks:**
    *   Integrate macOS `screencapture` for full-screen and window-specific snaps.
    *   Automate screenshot uploads to Discord upon UI-related milestones.
    *   **Success Metric:** Developer can see the current state of the UI from their phone/desktop Discord app.

### 2.2 The "Delta Feed" (Smart Diff)
*   **Goal:** Provide high-level summaries of code changes.
*   **Tasks:**
    *   Periodically calculate `git diff --stat`.
    *   Send the diff to Gemini for a "Plain English" summary.
    *   Post the summary as a Discord rich card.
    *   **Success Metric:** A clear summary of "What was changed" is visible every few minutes.

### 2.3 Playwright Verification
*   **Goal:** Automated UI testing before submission.
*   **Tasks:**
    *   Install and configure Playwright in the factory.
    *   Automate "Before/After" screenshot comparison.
    *   **Success Metric:** All UI changes are verified by a bot before being marked as done.

---

## Phase 3: Ecosystem & Delivery - Closing the Loop (Week 3)

### 3.1 PR Automation Pipeline
*   **Goal:** One-click transition to peer review.
*   **Tasks:**
    *   Implement `/push` command in Discord.
    *   Automate PR description generation using Discord thread history.
    *   **Success Metric:** A GitHub PR is created with a detailed log of the AI's reasoning and changes.

### 3.2 OpenClaw Skill Compatibility
*   **Goal:** Support legacy extensions.
*   **Tasks:**
    *   Implement a compatibility layer for `SKILL.md` files.
    *   Ensure `/add-*` commands work within the new architecture.

---

## Developer Specs (Coding Guidelines)

1.  **Variable Naming:** All AquaClaw environment variables must use the `AC_` prefix.
2.  **Working Language:** All code, logs, and comments must be in **English**.
3.  **Strict Isolation:** No task is allowed to touch files outside its factory directory.
4.  **Error Handling:** Every Tmux command must be wrapped in a retry/recovery block.
