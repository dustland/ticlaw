# Code Review: TiClaw

This document outlines findings regarding the feature functionality, code quality, and specific file issues observed in the codebase.

## Feature and Architectural Observations
1.  **AI Integration:** The project heavily leverages the `ai` SDK to interact with OpenRouter models (like `anthropic/claude-sonnet-4.6`). This functionality handles delegating instructions down to a local terminal-based "coding agent" (such as the Gemini CLI).
2.  **Terminal Interaction (Tmux):** To maintain isolated persistent execution environments per workspace, the backend starts `tmux` sessions. Tools like `captureSessionTool` and `sendToSessionTool` give the LLM orchestrator visibility and input capabilities directly over the CLI prompt.
3.  **Chat Providers:** It implements channels bridging Discord to trigger workspaces using real-time listener adapters (`DiscordChannel`).

## Quality and Resiliency Observations
1. **Error Handling on Terminal Polling:** In `src/executor/executor.ts`, the logic waits for an `idleIndicator` within tmux using `waitForIdle()`. The hardcoded polling intervals and strings work for Gemini CLI but might be fragile if another CLI is utilized.
2. **Command Injection Risks:** The application relies on `child_process.spawn()` and `child_process.execSync()`.
    *   In `src/tools/workspace.ts` the tool performs string interpolation like `git clone ... https://github.com/${repoFullName}.git`. This poses a command injection risk if `repoFullName` is not strictly validated (e.g. contains `;`, `|`, etc.). A regex check like `/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9._-]+$/` is advised.
    *   Similarly in `src/executor/tmux.ts`, variables are single-quoted but `execSync` is run.
3. **Promise Bottlenecks on Shutdown:** In `src/index.ts`, shutting down (`shutdown`) uses `Promise.allSettled(channels.map((ch) => ch.disconnect()))` which is good practice for parallel termination without bailing out on the first exception.

## File Issues and Testing Fixes
1.  **Missing Build Tool Configurations in `package.json`:** The project uses native modules `better-sqlite3` and `esbuild` that requires compilation logic during install. When running tests with `pnpm`, this wasn't correctly declared, resulting in bindings resolution failures.
    *   *Fix Applied:* Added `pnpm: { onlyBuiltDependencies: ["better-sqlite3", "esbuild"] }` to `package.json`.
2.  **Stale Mocks in `src/__tests__/agent.test.ts`:** The mocked exports for `../tools/executor.js` and `../tools/workspace.js` didn't match the updated signatures (e.g., `buildSessionTools` vs `buildExecutorTool` and `buildSetupWorkspaceTool`). Moreover, the `ai` SDK mock was missing `stepCountIs` stubbing, leading to unexpected invocation counts and missing properties.
    *   *Fix Applied:* Corrected `vi.mock` definitions to return current valid stubs and ensured `generateText` test assertions pass.