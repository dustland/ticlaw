import path from 'path';
import fs from 'fs';
import { logger } from '../core/logger.js';
import { readEnvFile } from '../core/env.js';
import { ContainerOutput, RegisteredProject } from '../core/types.js';
import { TmuxBridge } from './tmux.js';

export function readSecrets(): Record<string, string> {
  const secrets = readEnvFile([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_MODEL',
    'OPENROUTER_API_KEY',
    'TC_MODEL',
  ]);

  if (secrets.OPENROUTER_API_KEY) {
    if (!secrets.ANTHROPIC_API_KEY) {
      secrets.ANTHROPIC_API_KEY = secrets.OPENROUTER_API_KEY;
    }
    if (!secrets.ANTHROPIC_BASE_URL) {
      secrets.ANTHROPIC_BASE_URL = 'https://openrouter.ai/api/v1';
    }
    if (secrets.TC_MODEL) {
      secrets.ANTHROPIC_MODEL = secrets.TC_MODEL;
    } else if (!secrets.ANTHROPIC_MODEL) {
      secrets.ANTHROPIC_MODEL = 'anthropic/claude-3.5-sonnet';
    }
  } else if (secrets.TC_MODEL && !secrets.ANTHROPIC_MODEL) {
    secrets.ANTHROPIC_MODEL = secrets.TC_MODEL;
  }

  return secrets;
}

function shellEscapeSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Attempt to parse a line as JSON. If plain JSON.parse fails, try to find
 * a JSON object embedded in the line (CLI stderr may precede the JSON).
 */
function tryParseJson(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    // Try to extract JSON from a line like: "Error text...{\"type\":\"error\",...}"
    const idx = line.indexOf('{');
    if (idx > 0) {
      try {
        return JSON.parse(line.slice(idx)) as Record<string, unknown>;
      } catch {
        // Not valid JSON even from the first brace
      }
    }
    return null;
  }
}

function extractText(value: unknown): string | null {
  if (typeof value === 'string') return value;

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractText(item))
      .filter((part): part is string => Boolean(part && part.trim()));
    if (parts.length === 0) return null;
    return parts.join('');
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return (
      extractText(obj.text) ??
      extractText(obj.content) ??
      extractText(obj.message) ??
      extractText(obj.error)
    );
  }

  return null;
}

export interface ExecutorOptions {
  group: RegisteredProject;
  workspacePath: string;
  sessionId?: string;
  codingCli?: string;
  onOutput?: (output: ContainerOutput) => Promise<void> | void;
}

export class Executor {
  private opts: ExecutorOptions;

  constructor(opts: ExecutorOptions) {
    this.opts = opts;
  }

  async executePrompt(prompt: string): Promise<string> {
    const { group, workspacePath, sessionId, codingCli, onOutput } = this.opts;

    logger.info(
      { group: group.name, workspacePath, prompt: prompt.slice(0, 200) },
      'Executing workspace agent via Executor',
    );

    // Ensure workspace directory exists
    if (!fs.existsSync(workspacePath)) {
      logger.warn(
        { workspacePath },
        'Workspace directory does not exist — creating it',
      );
      fs.mkdirSync(workspacePath, { recursive: true });
    }

    const secrets = readSecrets();

    let bufferedChunk = '';
    let outputQueue = Promise.resolve();

    const emitMappedOutput = async (
      parsed: Record<string, unknown>,
    ): Promise<void> => {
      if (!onOutput) return;

      // Format mapping from coding CLI stream output to ContainerOutput.
      if (parsed.type === 'init' && typeof parsed.session_id === 'string') {
        await onOutput({
          status: 'success',
          result: null,
          newSessionId: parsed.session_id,
        });
        return;
      }

      if (parsed.type === 'error') {
        const errorText =
          extractText(parsed.error) ??
          extractText(parsed.message) ??
          'Agent CLI reported an unknown error';
        await onOutput({ status: 'error', result: null, error: errorText });
        return;
      }

      if (parsed.type === 'result') {
        if (parsed.status === 'error') {
          const errorText =
            extractText(parsed.error) ??
            extractText(parsed.message) ??
            'Agent CLI run failed';
          await onOutput({ status: 'error', result: null, error: errorText });
          return;
        }

        await onOutput({ status: 'success', result: null });
        return;
      }

      if (parsed.type === 'message' && parsed.role === 'assistant') {
        const contentText = extractText(parsed.content);
        if (contentText) {
          await onOutput({ status: 'success', result: contentText });
        }
        return;
      }

      const responseText = extractText(parsed.response);
      if (responseText) {
        await onOutput({ status: 'success', result: responseText });
      }
    };

    const processChunk = async (data: string): Promise<void> => {
      bufferedChunk += data;
      const lines = bufferedChunk.split('\n');
      bufferedChunk = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        const parsed = tryParseJson(line);
        if (parsed) {
          await emitMappedOutput(parsed);
        }
      }

      const maybeWholeLine = bufferedChunk.trim();
      if (!maybeWholeLine) return;
      const parsed = tryParseJson(maybeWholeLine);
      if (parsed) {
        bufferedChunk = '';
        await emitMappedOutput(parsed);
      }
    };

    const bridge = new TmuxBridge(group.folder, (data) => {
      outputQueue = outputQueue
        .then(() => processChunk(data))
        .catch((err) => {
          logger.warn({ err }, 'Failed to process executor output stream');
        });
      return outputQueue;
    });

    const sessionExists = await bridge.hasSession();

    if (!sessionExists) {
      await bridge.createSession(workspacePath);
    }

    bridge.startTailing();

    // Write prompt to a temp file to avoid bash escaping issues
    const stamp = `${Date.now()}-${process.pid}`;
    const promptFile = path.join(workspacePath, `.prompt-${stamp}.txt`);
    fs.writeFileSync(promptFile, prompt);

    // Build exports for secrets
    const exportsArray = Object.entries(secrets).map(
      ([k, v]) => `export ${k}=${shellEscapeSingleQuoted(v as string)}`,
    );
    const exportsCmd = exportsArray.join('\n');

    const cliArgs = [
      '-p',
      '"$(cat \"$PROMPT_FILE\")"',
      '-y',
      '-o',
      'stream-json',
    ];
    // Only pass --resume when we have a previously captured session ID.
    // On first run, sessionId will be undefined; the init event emits the
    // new session ID which the caller persists for subsequent runs.
    if (sessionId) {
      cliArgs.push('--resume', shellEscapeSingleQuoted(sessionId));
    }

    const cliCommand = codingCli || 'gemini';

    const runScript = path.join(workspacePath, `.run-${stamp}.sh`);
    const scriptContent = `#!/bin/bash
set -euo pipefail
cd ${shellEscapeSingleQuoted(workspacePath)}
PROMPT_FILE=${shellEscapeSingleQuoted(promptFile)}
OUTPUT_FILE=${shellEscapeSingleQuoted(bridge.outputPath)}
cleanup() {
  rm -f -- "$PROMPT_FILE" "$0"
}
trap cleanup EXIT
${exportsCmd}
set +e
${cliCommand} ${cliArgs.join(' ')} 2>&1 | tee -a "$OUTPUT_FILE"
CLI_EXIT_CODE=\${PIPESTATUS[0]}
set -e
if [ "$CLI_EXIT_CODE" -ne 0 ]; then
  printf '\n{"type":"error","error":"Agent CLI exited with code %s"}\n' "$CLI_EXIT_CODE" | tee -a "$OUTPUT_FILE"
  exit "$CLI_EXIT_CODE"
fi
`;
    fs.writeFileSync(runScript, scriptContent, { mode: 0o700 });

    try {
      await bridge.sendKeys(`bash ${shellEscapeSingleQuoted(runScript)}`);
      logger.info(
        { sessionId: `tc-${group.folder}`, script: runScript },
        'Command sent to tmux session',
      );
      return 'Dispatched instruction to the workspace agent.';
    } catch (err: any) {
      logger.error({ err }, 'Failed to send command to tmux');
      // Clean up temp files
      try {
        fs.unlinkSync(promptFile);
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(runScript);
      } catch {
        /* ignore */
      }
      return `Error dispatching to workspace agent: ${err.message}`;
    }
  }
}
