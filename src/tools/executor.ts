import { tool } from 'ai';
import { z } from 'zod';
import { readEnvFile } from '../core/env.js';
import { Executor } from '../executor/index.js';
import { ContainerOutput, RegisteredProject } from '../core/types.js';
import { logger } from '../core/logger.js';

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
      secrets.ANTHROPIC_MODEL = 'anthropic/claude-sonnet-4.6';
    }
  } else if (secrets.TC_MODEL && !secrets.ANTHROPIC_MODEL) {
    secrets.ANTHROPIC_MODEL = secrets.TC_MODEL;
  }

  return secrets;
}

/**
 * Callback that fires when Gemini becomes idle after a prompt is sent.
 * The agent layer provides this so we can deliver results asynchronously.
 */
export type OnIdleCallback = (screen: string) => void;
export type OnProgressCallback = (screen: string, elapsedMs: number) => void;

export const buildSessionTools = (
  group: RegisteredProject,
  workspacePath: string,
  chatJid: string,
  _isMain: boolean,
  _sessionId?: string,
  codingCli?: string,
  _onOutput?: (output: ContainerOutput) => Promise<void> | void,
  onIdleCallback?: OnIdleCallback,
  onProgressCallback?: OnProgressCallback,
) => {
  const executor = new Executor({
    group,
    workspacePath,
    codingCli,
  });

  const captureSessionTool = tool({
    description:
      'Capture the terminal screen of the workspace agent session. ' +
      'Set waitForIdle=true to wait until the agent finishes processing (blocking). ' +
      'Set waitSeconds to add a fixed delay before capturing. ' +
      'Returns the raw terminal screen content.',
    inputSchema: z.object({
      waitForIdle: z
        .boolean()
        .optional()
        .describe(
          'If true, polls until the CLI is idle. Use for quick checks where you need the result immediately.',
        ),
      waitSeconds: z
        .number()
        .optional()
        .describe('Seconds to wait before capturing.'),
    }),
    execute: async ({ waitForIdle, waitSeconds }) => {
      try {
        if (waitForIdle) {
          logger.info({ chatJid }, 'captureSession: waiting for idle');
          const screen = await executor.waitForIdle();
          logger.info(
            { chatJid, screenLength: screen.length },
            'captureSession: idle',
          );
          return screen;
        }

        if (waitSeconds && waitSeconds > 0) {
          logger.info({ chatJid, waitSeconds }, 'captureSession: waiting');
          await new Promise((r) => setTimeout(r, waitSeconds * 1000));
        }

        logger.info({ chatJid }, 'captureSession: capturing');
        const screen = await executor.capture();
        logger.info(
          { chatJid, screenLength: screen.length },
          'captureSession: done',
        );
        return screen;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error({ chatJid, err: message }, 'captureSession failed');
        return `Error: ${message}`;
      }
    },
  });

  const sendToSessionTool = tool({
    description:
      'Send text to the workspace agent session (types text + Enter). ' +
      'After sending, a background monitor automatically watches for the agent to finish ' +
      'and will deliver the result to Discord asynchronously. ' +
      'You do NOT need to capture the result yourself — just send and tell the user the task is underway.',
    inputSchema: z.object({
      text: z
        .string()
        .describe('The natural language prompt to send to Gemini.'),
    }),
    execute: async ({ text }) => {
      logger.info(
        { chatJid, text: text.slice(0, 100) },
        'sendToSession called',
      );
      try {
        await executor.send(text);

        // Start background idle monitor
        if (onIdleCallback) {
          logger.info({ chatJid }, 'Starting background idle monitor');
          executor.monitorForIdle(
            (screen) => {
              logger.info(
                { chatJid, screenLength: screen.length },
                'Background monitor: idle detected, firing callback',
              );
              onIdleCallback(screen);
            },
            {
              onProgress: onProgressCallback,
            },
          );
        }

        return 'Sent. A background monitor is watching the agent and will deliver the result to Discord automatically when done.';
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error({ chatJid, err: message }, 'sendToSession failed');
        return `Error: ${message}`;
      }
    },
  });

  return { captureSessionTool, sendToSessionTool };
};
