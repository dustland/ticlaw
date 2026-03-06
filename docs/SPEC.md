# TiClaw Specification

A distributed AI R&D engine with multi-channel support, physical workspace isolation, automated observability, and multi-CLI agent execution. Supports Gemini CLI (default), Claude Code, and Codex.

---

## Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Runtime | Node.js 20+ | Host process for routing and scheduling |
| Agent | Multi-CLI (Gemini CLI default, Claude Code, Codex) | Run AI agent with tools and MCP servers |
| Workspace | Physical directories (`~/ticlaw/factory/`) | Isolated per-task work environments |
| Persistence | Tmux sessions | Agent survives host process restarts |
| Observability | Gemini 2.0 Flash + Playwright | Delta feed summaries and UI verification |
| Channel | Channel registry (`src/channels/registry.ts`) | Channels self-register at startup |
| Storage | SQLite (better-sqlite3) | Messages, groups, sessions, tasks |
| PR Automation | GitHub CLI (`gh`) | Create PRs from workspace changes |

---

## Architecture Overview

TiClaw operates in two execution modes selected at runtime:

1. **Physical Mode** (default) — Agent runs directly on the host in a Tmux session within a physical workspace (`~/ticlaw/factory/{id}/`). Provides native toolchain access.
2. **Container Mode** (fallback) — Agent runs inside a Linux container. Used when container runtime is available and desired for stronger isolation.

### System Diagram

```
[Discord / Slack / WhatsApp / Telegram]
         │
         ▼
   ┌──────────────────────────┐
   │  TiClaw Host Process    │
   │  (src/index.ts)           │
   │                           │
   │  ┌─────────────────────┐  │
   │  │  Channel Registry   │  │
   │  │  (self-registration)│  │
   │  └────────┬────────────┘  │
   │           │               │
   │  ┌────────▼────────────┐  │
   │  │  Message Router     │  │
   │  │  (trigger matching) │  │
   │  └────────┬────────────┘  │
   │           │               │
   │  ┌────────▼────────────┐  │
   │  │  Group Queue        │  │
   │  │  (concurrency ctrl) │  │
   │  └────────┬────────────┘  │
   │           │               │
   │  ┌────────▼────────────┐  │
   │  │  runAgent()         │  │
   │  │  ┌───────────────┐  │  │
   │  │  │ Physical Mode │  │  │
   │  │  │ TcWorkspace   │◄─┼──┼── /verify, /push, /skill
   │  │  │ + TmuxBridge  │  │  │
   │  │  └───────────────┘  │  │
   │  │  ┌───────────────┐  │  │
   │  │  │ Container Mode│  │  │
   │  │  │ (fallback)    │  │  │
   │  │  └───────────────┘  │  │
   │  └─────────────────────┘  │
   │                           │
   │  ┌─────────────────────┐  │
   │  │  Task Scheduler     │  │
   │  │  (cron / interval)  │  │
   │  └─────────────────────┘  │
   └───────────────────────────┘
```

---

## Channel System

The core ships with no channels built in — each channel (Discord, Slack, Telegram, WhatsApp, Gmail) is added via a skill (e.g., `/add-discord`). Each skill contributes the channel implementation and registers it at startup via `registerChannel()`. Installed channels with missing credentials emit a WARN log and are skipped.

### Channel Interface

```typescript
interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  sendFile(jid: string, filePath: string, caption?: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  syncGroups?(force: boolean): Promise<void>;
}
```

### Channel Callbacks

Channels are instantiated with these callbacks:

| Callback | Purpose |
|----------|---------|
| `onMessage` | Stores inbound message to SQLite |
| `onChatMetadata` | Records chat/group discovery |
| `onGroupRegistered` | Registers a new group |
| `onVerify` | Triggers Playwright verification |
| `onPush` | Triggers GitHub PR creation |
| `onSkill` | Applies a skill to the workspace |

### Adding a Channel

Channels are added via skills. Each channel skill:

1. Provides a channel implementation of the `Channel` interface
2. Calls `registerChannel('my-channel', factory)` at module load
3. Handles authentication flow and credential setup
4. Auto-registers at startup when credentials are present in `.env`

---

## Folder Structure

```
ticlaw/                              # Project root (source code)
├── CLAUDE.md / GEMINI.md              # Project context for AI coding CLIs
├── docs/
│   ├── SPEC.md                        # This specification document
│   ├── ARCHITECTURE.md                # High-level architecture guide
│   ├── REQUIREMENTS.md                # Philosophy and design goals
│   ├── SECURITY.md                    # Security model
│   ├── SKILLS.md                      # Skills architecture (merge system)
│   └── USER_GUIDE.md                  # End-user guide
│
├── src/
│   ├── index.ts                       # Main entry — routing, agent dispatch
│   ├── config.ts                      # Configuration (env vars, paths)
│   ├── db.ts                          # SQLite schema and queries
│   ├── types.ts                       # TypeScript interfaces
│   ├── env.ts                         # .env file reader
│   ├── logger.ts                      # Pino logger
│   ├── group-folder.ts               # Group folder management
│   ├── group-queue.ts                 # Concurrency-controlled message queue
│   ├── router.ts                      # Outbound message routing
│   ├── task-scheduler.ts              # Cron/interval/one-time task scheduler
│   ├── container-runner.ts            # Container mode agent execution
│   ├── container-runtime.ts           # Container lifecycle management
│   ├── mount-security.ts             # Mount validation for container mode
│   ├── ipc.ts                         # IPC for container ↔ host communication
│   ├── channels/
│   │   ├── index.ts                   # Auto-imports installed channels
│   │   ├── registry.ts               # Channel factory registry
│   │   └── discord.ts                # Discord channel (reference implementation)
│   └── executor/
│       ├── workspace.ts               # TcWorkspace — physical workspace manager
│       ├── tmux-bridge.ts             # TmuxBridge — persistent agent sessions
│       ├── diff-summarizer.ts         # Gemini-powered git diff summaries
│       └── playwright-verifier.ts     # Playwright UI verification
│
├── container/
│   ├── Dockerfile                     # Container image for container mode
│   └── agent-runner/                  # Agent execution code (used by both modes)
│       ├── package.json
│       └── src/index.ts               # Agent runner entry point
│
├── skills/                            # CLI-agnostic skill packages
│   ├── setup/SKILL.md                 # First-time installation guide
│   ├── debug/SKILL.md                 # Container/agent debugging
│   ├── add-discord/                   # Discord channel skill
│   ├── add-telegram/                  # Telegram channel skill
│   └── ...                            # Other skills
│
├── launchd/
│   └── com.ticlaw.plist             # macOS launchd service definition
│
└── .env                               # Environment configuration (gitignored)

~/ticlaw/                            # Runtime data (outside project root)
├── factory/                           # Physical workspaces (one per task)
│   ├── {thread-id}/                   # Workspace for a Discord thread
│   │   ├── .git/                      # Cloned repository
│   │   ├── screenshots/               # Playwright captures
│   │   ├── logs/                      # Agent execution logs
│   │   └── ipc/                       # Input/output for agent runner
│   └── ...
├── store/
│   ├── messages.db                    # SQLite database
│   └── auth/                          # Channel auth data (WhatsApp sessions)
├── groups/                            # Group memory folders
│   ├── CLAUDE.md                      # Global memory (all groups)
│   └── {group-name}/
│       └── CLAUDE.md                  # Per-group memory
├── data/
│   ├── env/env                        # Filtered secrets for container mode
│   └── sessions/{group}/.claude/      # Session transcripts
├── config/
│   └── environments/                  # Environment seeds for auto-bootstrap
│       ├── {repo-name}.env            # Root .env seed
│       └── {repo-name}/              # Granular env overlay (recursive copy)
└── logs/
    └── ticlaw.log                   # Service log
```

---

## Physical Mode (TcWorkspace + TmuxBridge)

Physical mode is the primary execution model. Each task gets an isolated workspace on the host filesystem.

### Workspace Lifecycle

1. **Creation** — `TcWorkspace` creates `~/ticlaw/factory/{id}/` with subdirectories (`screenshots/`, `logs/`, `ipc/`)
2. **Bootstrap** (if GitHub URL provided):
   - `git clone` → branch checkout
   - Environment seeding from `~/ticlaw/config/environments/`
   - Auto-detect and run setup scripts (`setup.sh`, `bootstrap.sh`, `init.sh`)
   - Auto-detect package manager (`pnpm install` or `npm install`)
3. **File Watching** — `chokidar` monitors the workspace, excluding `node_modules/`, `.git/`, `dist/`, `logs/`
4. **Agent Execution** — `TmuxBridge` creates a persistent tmux session running the `agent-runner`
5. **Teardown** — `workspace.stop()` closes watcher and Playwright browser

### Environment Seeding

For repositories with complex environment requirements (e.g., monorepos), TiClaw supports granular environment seeding:

```
~/ticlaw/config/environments/
├── my-project.env              # Simple: copies to workspace root as .env
└── my-monorepo/                # Granular: recursively overlays the workspace
    ├── .env                    # Root .env
    ├── packages/api/.env       # Nested .env for API package
    └── packages/web/.env       # Nested .env for web package
```

### Observability Features

| Feature | Component | How It Works |
|---------|-----------|-------------|
| **Delta Feed** | `DiffSummarizer` | Runs `git diff HEAD`, sends to Gemini 2.0 Flash for a one-sentence summary. Throttled to 1/minute. Requires `TC_GEMINI_API_KEY`. |
| **Screenshot Relay** | `chokidar` watcher | New files in `screenshots/` are automatically sent to the channel as media. |
| **UI Verification** | `PlaywrightVerifier` | Captures full-page screenshots of a URL using headless Chromium (1280×800). Triggered by `/verify` command. |

### PR Automation

The `/push` command triggers `workspace.push()`:

1. Collects conversation history from SQLite
2. Generates a diff summary via DiffSummarizer
3. Runs `gh pr create` with an auto-generated title and body
4. If `TC_PREVIEW_URL_PATTERN` is set (e.g., `https://app-pr-${PR_NUMBER}.onrender.com`), includes a live preview URL

### Port Isolation

`PortLocker` assigns unique ports (3000–3050) per workspace to prevent conflicts when multiple tasks run dev servers simultaneously.

---

## Agent CLI Authentication

Configure authentication in a `.env` file in the project root. The default CLI is Gemini (set via `TC_CODING_CLI`).

**Gemini CLI** (default — uses Google One AI Premium subscription):
```bash
# Login once with: gemini login
# No API key needed — uses your Google account
TC_CODING_CLI=gemini
```

**Claude Code** (requires Anthropic API key or subscription):
```bash
TC_CODING_CLI=claude
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
# Or: ANTHROPIC_API_KEY=sk-ant-api03-...
```

### Changing the Assistant Name

```bash
# In .env
ASSISTANT_NAME=Andy
```

The trigger pattern is auto-generated as `@{ASSISTANT_NAME}` (case-insensitive). Messages must start with this trigger to be processed (unless `requiresTrigger: false` for solo chats).

---

## Memory System

TiClaw uses a hierarchical memory system based on instruction files (CLAUDE.md / GEMINI.md).

### Memory Hierarchy

| Level | File | Scope | Writable From |
|-------|------|-------|---------------|
| Global | `~/ticlaw/groups/CLAUDE.md` | All groups | Main group only |
| Group | `~/ticlaw/groups/{name}/CLAUDE.md` | One group | That group |

The AI coding CLI automatically loads project instructions:
- `../CLAUDE.md` or `../GEMINI.md` (parent directory = global memory)
- `./CLAUDE.md` or `./GEMINI.md` (current directory = group memory)

---

## Session Management

Sessions enable conversation continuity — the agent remembers what you talked about.

### How Sessions Work

1. Each group has a session ID tracked in SQLite (`sessions` table)
2. Session ID is passed to the agent CLI's resume option
3. The agent continues the conversation with full context
4. Session transcripts are stored in `~/ticlaw/data/sessions/{group}/.claude/`

In physical mode, tmux sessions provide additional persistence — the agent survives process restarts.

---

## Message Flow

```
1. Channel receives message
   │
   ▼
2. Channel stores message to SQLite via onMessage callback
   │
   ▼
3. Message loop polls SQLite every 2 seconds
   │
   ▼
4. For each registered group with new messages:
   ├── Check trigger pattern (@Andy)
   ├── Skip if no trigger match (unless requiresTrigger: false)
   └── Enqueue to GroupQueue
   │
   ▼
5. GroupQueue processes (max 5 concurrent):
   └── Build prompt with full conversation context
   │
   ▼
6. runAgent() dispatches to:
   ├── Physical mode: TcWorkspace + TmuxBridge
   │   ├── Create/reuse workspace in ~/ticlaw/factory/{id}/
   │   ├── Spawn tmux session running agent-runner
   │   ├── Stream output via tmux capture-pane polling
   │   └── Parse TICLAW_OUTPUT markers for structured results
   │
   └── Container mode (fallback): container-runner.ts
       ├── Spawn Linux container with volume mounts
       ├── Pipe prompt via stdin
       └── Stream output via stdout/stderr
   │
   ▼
7. Agent processes message:
   ├── Reads project instruction files for context
   └── Uses tools as needed (search, email, etc.)
   │
   ▼
8. Result relayed back through channel
```

---

## Scheduled Tasks

Users can ask the agent to schedule recurring or one-time tasks from any group.

### Task Types

| Type | Value Format | Example |
|------|-------------|---------|
| cron | Cron expression | `0 9 * * *` (daily at 9am) |
| interval | Milliseconds | `3600000` (every hour) |
| once | ISO 8601 timestamp | `2026-03-15T10:00:00Z` |

### MCP Tools Available to Agent

The `ticlaw` MCP server exposes these tools inside the agent:

| Tool | Description |
|------|-------------|
| `schedule_task` | Create a scheduled task |
| `list_tasks` | View scheduled tasks |
| `pause_task` | Pause a task |
| `resume_task` | Resume a paused task |
| `cancel_task` | Cancel a task |
| `send_message` | Send message to any chat (main only) or own chat |

### Task Execution

The scheduler loop runs every 60 seconds, checking for due tasks. Tasks execute through the same `runAgent()` path as regular messages, in the context of the group that created them.

---

## Group Management

### Registration

Groups are registered in SQLite with:
- `jid` — unique channel identifier
- `name` — human-readable name
- `folder` — disk folder name (validated: alphanumeric + hyphens only)
- `trigger` — trigger pattern for this group
- `isMain` — admin privileges flag

### Main Group Privileges

| Capability | Main | Non-Main |
|------------|------|----------|
| Write global memory | ✓ | ✗ |
| Schedule tasks for any group | ✓ | Own only |
| View all tasks | ✓ | Own only |
| Send messages to other chats | ✓ | ✗ |

---

## Database Schema

SQLite database at `~/ticlaw/store/messages.db`:

| Table | Purpose |
|-------|---------|
| `chats` | Discovered chat/group metadata |
| `messages` | All inbound/outbound messages |
| `scheduled_tasks` | Task definitions and scheduling state |
| `task_run_logs` | Task execution history |
| `router_state` | Last-processed timestamps per chat |
| `sessions` | Agent session IDs per group |
| `registered_groups` | Group configuration |

---

## Configuration Reference

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TC_CODING_CLI` | `gemini` | AI CLI to use (`gemini`, `claude`, `codex`) |
| `ASSISTANT_NAME` | `Andy` | Trigger name and response prefix |
| `ASSISTANT_HAS_OWN_NUMBER` | `false` | Solo chat mode (no trigger needed) |
| `TC_GEMINI_API_KEY` | — | Gemini API key for Delta Feed summaries |
| `TC_PREVIEW_URL_PATTERN` | — | Preview URL template (e.g., `https://app-pr-${PR_NUMBER}.onrender.com`) |
| `CONTAINER_IMAGE` | `ticlaw-agent:latest` | Container image for container mode |
| `CONTAINER_TIMEOUT` | `1800000` (30min) | Max container lifetime |
| `IDLE_TIMEOUT` | `1800000` (30min) | Container idle timeout |
| `MAX_CONCURRENT_CONTAINERS` | `5` | Max simultaneous agents |
| `TZ` | System timezone | Timezone for cron expressions |

### Authentication Variables (filtered to agent)

| Variable | CLI | Purpose |
|----------|-----|---------|
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code | OAuth token for Claude subscription |
| `ANTHROPIC_API_KEY` | Claude Code | API key for pay-per-use Claude |
| `GEMINI_API_KEY` | Gemini CLI | API key (if not using Google account auth) |

---

## Service Management

TiClaw runs as a macOS launchd service:

```bash
# Start
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ticlaw.plist

# Stop
launchctl bootout gui/$(id -u)/com.ticlaw

# Restart
launchctl kickstart -k gui/$(id -u)/com.ticlaw

# Check status
launchctl list | grep ticlaw

# View logs
tail -f ~/ticlaw/logs/ticlaw.log

# Rebuild after code changes
npm run build && launchctl kickstart -k gui/$(id -u)/com.ticlaw
```

---

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| No response to messages | Service not running | Check `launchctl list \| grep ticlaw` |
| Agent process exits with code 1 | Container runtime not available | Falls back to physical mode; check tmux sessions with `tmux ls` |
| Agent process exits with code 1 | agent-runner not built | Run `pnpm --filter ticlaw-agent-runner build` |
| Session not continuing | Session ID not saved | Check SQLite: `sqlite3 ~/ticlaw/store/messages.db "SELECT * FROM sessions"` |
| No Delta Feed summaries | Missing API key | Set `TC_GEMINI_API_KEY` in `.env` |
| `/push` fails | GitHub CLI not authenticated | Run `gh auth login` |
| `/verify` fails | Playwright not installed | Run `npx playwright install chromium` |
| Channel skipped at startup | Missing credentials | Check logs for WARN — provide required env vars |
