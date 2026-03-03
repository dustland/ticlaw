/**
 * AquaClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 */

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
  codingCli?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  lastAssistantUuid?: string;
  error?: string;
}

let IPC_INPUT_DIR = '/workspace/ipc/input';
let IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

/**
 * Resolve workspace root from the group folder path.
 * In containers: groupFolder = /workspace/group → root = /workspace
 * Physical: groupFolder = /path/to/groups/folder → root = groupFolder (self-contained)
 */
function resolveWorkspaceRoot(groupFolder: string): string {
  if (groupFolder === '/workspace/group') return '/workspace';
  return groupFolder;
}

const OUTPUT_START_MARKER = '---AQUACLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---AQUACLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

/**
 * Driver interface for different coding CLIs.
 */
interface Driver {
  run(params: {
    prompt: string;
    sessionId?: string;
    containerInput: ContainerInput;
    sdkEnv: Record<string, string | undefined>;
    resumeAt?: string;
    onResult: (output: ContainerOutput) => void;
  }): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }>;
}

/**
 * Claude Driver using @anthropic-ai/claude-agent-sdk.
 */
class ClaudeDriver implements Driver {
  async run(params: {
    prompt: string;
    sessionId?: string;
    containerInput: ContainerInput;
    sdkEnv: Record<string, string | undefined>;
    resumeAt?: string;
    onResult: (output: ContainerOutput) => void;
  }) {
    const stream = new MessageStream();
    stream.push(params.prompt);

    let ipcPolling = true;
    let closedDuringQuery = false;
    const pollIpcDuringQuery = () => {
      if (!ipcPolling) return;
      if (shouldClose()) {
        log('Close sentinel detected during query, ending stream');
        closedDuringQuery = true;
        stream.end();
        ipcPolling = false;
        return;
      }
      const messages = drainIpcInput();
      for (const text of messages) {
        log(`Piping IPC message into active query (${text.length} chars)`);
        stream.push(text);
      }
      setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
    };
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

    let newSessionId: string | undefined;
    let lastAssistantUuid: string | undefined;

    const wsRoot = resolveWorkspaceRoot(params.containerInput.groupFolder);
    const globalClaudeMdPath = path.join(wsRoot, 'global', 'CLAUDE.md');
    let globalClaudeMd: string | undefined;
    if (!params.containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
      globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
    }

    const extraDirs: string[] = [];
    const extraBase = path.join(wsRoot, 'extra');
    if (fs.existsSync(extraBase)) {
      for (const entry of fs.readdirSync(extraBase)) {
        const fullPath = path.join(extraBase, entry);
        if (fs.statSync(fullPath).isDirectory()) {
          extraDirs.push(fullPath);
        }
      }
    }

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

    for await (const message of query({
      prompt: stream,
      options: {
        cwd: params.containerInput.groupFolder,
        additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
        resume: params.sessionId,
        resumeSessionAt: params.resumeAt,
        systemPrompt: globalClaudeMd
          ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
          : undefined,
        allowedTools: [
          'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
          'WebSearch', 'WebFetch',
          'Task', 'TaskOutput', 'TaskStop',
          'TeamCreate', 'TeamDelete', 'SendMessage',
          'TodoWrite', 'ToolSearch', 'Skill',
          'NotebookEdit',
          'mcp__aquaclaw__*'
        ],
        env: params.sdkEnv,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        mcpServers: {
          aquaclaw: {
            command: 'node',
            args: [mcpServerPath],
            env: {
              AQUACLAW_CHAT_JID: params.containerInput.chatJid,
              AQUACLAW_GROUP_FOLDER: params.containerInput.groupFolder,
              AQUACLAW_IS_MAIN: params.containerInput.isMain ? '1' : '0',
            },
          },
        },
        hooks: {
          PreCompact: [{ hooks: [createPreCompactHook(params.containerInput.assistantName)] }],
          PreToolUse: [{ matcher: 'Bash', hooks: [createSanitizeBashHook()] }],
        },
      }
    })) {
      if (message.type === 'assistant' && 'uuid' in message) {
        lastAssistantUuid = (message as { uuid: string }).uuid;
      }
      if (message.type === 'system' && (message as any).subtype === 'init') {
        newSessionId = (message as any).session_id;
      }
      if (message.type === 'result') {
        const textResult = 'result' in message ? (message as { result?: string }).result : null;
        params.onResult({
          status: 'success',
          result: textResult || null,
          newSessionId
        });
      }
    }

    ipcPolling = false;
    return { newSessionId, lastAssistantUuid, closedDuringQuery };
  }
}

/**
 * Gemini Driver spawning the `gemini` CLI.
 */
class GeminiDriver implements Driver {
  async run(params: {
    prompt: string;
    sessionId?: string;
    containerInput: ContainerInput;
    sdkEnv: Record<string, string | undefined>;
    resumeAt?: string;
    onResult: (output: ContainerOutput) => void;
  }) {
    return new Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }>((resolve, reject) => {
      const args = ['-p', params.prompt, '-y', '-o', 'stream-json'];
      if (params.sessionId) {
        args.push('--resume', params.sessionId);
      }

      log(`Spawning gemini CLI: gemini ${args.join(' ')}`);
      const child = spawn('gemini', args, {
        cwd: params.containerInput.groupFolder,
        env: { ...params.sdkEnv, ...process.env }
      });

      let newSessionId: string | undefined;
      let assistantContent: string | undefined;
      let buffer = '';

      child.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            // stream-json format:
            // {"type":"init","session_id":"..."}
            // {"type":"message","role":"assistant","content":"..."}
            // {"type":"result","status":"success","stats":{...}}
            if (parsed.type === 'init' && parsed.session_id) {
              newSessionId = parsed.session_id;
            }
            if (parsed.type === 'message' && parsed.role === 'assistant' && parsed.content) {
              assistantContent = parsed.content;
            }
            if (parsed.type === 'result') {
              params.onResult({
                status: 'success',
                result: assistantContent || null,
                newSessionId
              });
            }
            // Also support legacy -o json format
            if (parsed.response) {
              params.onResult({
                status: 'success',
                result: parsed.response,
                newSessionId: parsed.session_id || newSessionId,
              });
            }
          } catch (err) {
            // Partial JSON or other output, ignore
          }
        }
      });

      child.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) log(`[gemini-stderr] ${msg}`);
      });

      child.on('close', (code) => {
        log(`Gemini CLI exited with code ${code}`);
        if (code === 0) {
          resolve({ newSessionId, closedDuringQuery: false });
        } else {
          // If code is non-zero but we got some output, maybe it's fine?
          // But usually code 0 is required for success.
          resolve({ newSessionId, closedDuringQuery: false });
        }
      });

      child.on('error', (err) => {
        log(`Gemini CLI spawn error: ${err.message}`);
        reject(err);
      });
    });
  }
}

/**
 * Codex Driver skeleton.
 */
class CodexDriver implements Driver {
  async run(params: {
    prompt: string;
    sessionId?: string;
    containerInput: ContainerInput;
    sdkEnv: Record<string, string | undefined>;
    resumeAt?: string;
    onResult: (output: ContainerOutput) => void;
  }) {
    return new Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }>((resolve) => {
      params.onResult({
        status: 'error',
        result: null,
        error: 'Codex driver not yet implemented'
      });
      resolve({ closedDuringQuery: false });
    });
  }
}

/**
 * Push-based async iterable for streaming user messages to the SDK.
 */
class MessageStream {
  private queue: any[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<any> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      return {};
    }
    // Archive logic can be added here if needed for Gemini too
    return {};
  };
}

const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

function createSanitizeBashHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command) return {};

    const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(preInput.tool_input as Record<string, unknown>),
          command: unsetPrefix + command,
        },
      },
    };
  };
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        try { fs.unlinkSync(filePath); } catch { }
      }
    }
    return messages;
  } catch (err) {
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { }
    log(`Received input for group: ${containerInput.groupFolder} (CLI: ${containerInput.codingCli || 'gemini'})`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }

  // Resolve IPC paths based on actual groupFolder
  const wsRoot = resolveWorkspaceRoot(containerInput.groupFolder);
  IPC_INPUT_DIR = path.join(wsRoot, 'ipc', 'input');
  IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { }

  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    prompt += '\n' + pending.join('\n');
  }

  const codingCli = containerInput.codingCli || 'gemini';
  let driver: Driver;
  if (codingCli === 'claude') {
    driver = new ClaudeDriver();
  } else if (codingCli === 'gemini') {
    driver = new GeminiDriver();
  } else if (codingCli === 'codex') {
    driver = new CodexDriver();
  } else {
    driver = new GeminiDriver();
  }

  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query with ${codingCli} (session: ${sessionId || 'new'})...`);

      const queryResult = await driver.run({
        prompt,
        sessionId,
        containerInput,
        sdkEnv,
        resumeAt,
        onResult: (output) => writeOutput(output)
      });

      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message, starting new query with ${codingCli}`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
