import { tool } from 'ai';
import { z } from 'zod';
import { readEnvFile } from '../core/env.js';
import { Executor } from '../executor/index.js';
import { ContainerOutput, RegisteredProject } from '../core/types.js';

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

export const buildExecutorTool = (
  group: RegisteredProject,
  workspacePath: string,
  chatJid: string,
  isMain: boolean,
  sessionId?: string,
  codingCli?: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
) => {
  const executor = new Executor({
    group,
    workspacePath,
    sessionId,
    codingCli,
    onOutput,
  });

  return tool({
    description: `Runs the AI coding agent inside a tmux session for the current workspace. Use this when the user asks you to perform a coding task, fix a bug, review a PR, change the architecture, or explore the codebase. Provide the precise prompt to instruct the agent on what to do. DO NOT attempt to write or edit code yourself. ALWAYS delegate codebase tasks to this tool.`,
    parameters: z.object({
      prompt: z
        .string()
        .describe(
          'The prompt to send to the workspace agent (e.g., "Fix issue #123" or "Review the latest changes").',
        ),
    }),
    execute: async ({ prompt }: any) => {
      return await executor.executePrompt(prompt);
    },
  } as any);
};
