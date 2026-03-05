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

export interface ExecutorOptions {
  group: RegisteredProject;
  workspacePath: string;
  sessionId?: string;
  codingCli?: string;
  onOutput?: (output: ContainerOutput) => Promise<void>;
}

export class Executor {
  private opts: ExecutorOptions;

  constructor(opts: ExecutorOptions) {
    this.opts = opts;
  }

  async executePrompt(prompt: string): Promise<string> {
    const { group, workspacePath, sessionId, codingCli, onOutput } = this.opts;

    logger.info(
      { group: group.name, prompt },
      'Executing workspace agent via Executor',
    );

    const secrets = readSecrets();

    const bridge = new TmuxBridge(group.folder, async (data) => {
      if (!onOutput) return;

      const lines = data.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const parsed = JSON.parse(line.trim());

          // Format mapping from gemini to ContainerOutput
          if (parsed.type === 'init' && parsed.session_id) {
            await onOutput({
              status: 'success',
              result: null,
              newSessionId: parsed.session_id,
            });
          } else if (
            parsed.type === 'message' &&
            parsed.role === 'assistant' &&
            parsed.content
          ) {
            await onOutput({ status: 'success', result: parsed.content });
          } else if (parsed.type === 'result') {
            await onOutput({ status: 'success', result: null });
          } else if (parsed.response) {
            await onOutput({ status: 'success', result: parsed.response });
          }
        } catch {
          // Ignore non-JSON output from the shell or gemini
        }
      }
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
${cliCommand} ${cliArgs.join(' ')} >> "$OUTPUT_FILE" 2>&1
`;
    fs.writeFileSync(runScript, scriptContent, { mode: 0o700 });

    await bridge.sendKeys(`bash ${shellEscapeSingleQuoted(runScript)}`);

    return 'Dispatched instruction to the workspace agent.';
  }
}
