import { generateText, hasToolCall, type ModelMessage } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { ContainerOutput } from './core/types.js';
import { buildExecutorTool } from './tools/executor.js';
import { buildWorkspaceTool } from './tools/workspace.js';
import { readEnvFile } from './core/env.js';
import { logger } from './core/logger.js';
import { RegisteredProject } from './core/types.js';

let openrouterInstance: ReturnType<typeof createOpenRouter> | null = null;

function getOpenRouter(): ReturnType<typeof createOpenRouter> {
  if (openrouterInstance) return openrouterInstance;

  const env = readEnvFile(['OPENROUTER_API_KEY', 'LLM_MODEL', 'LLM_BASE_URL']);
  const apiKey = process.env.OPENROUTER_API_KEY || env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error(
      'OPENROUTER_API_KEY not configured. Add it to ~/ticlaw/config.yaml under llm.api_key',
    );
  }

  openrouterInstance = createOpenRouter({ apiKey });
  return openrouterInstance;
}

export function getModelName(): string {
  const env = readEnvFile(['LLM_MODEL']);
  return process.env.LLM_MODEL || env.LLM_MODEL || 'google/gemini-2.5-flash';
}

/**
 * The main agent loop that orchestrates tasks and uses manual tool abstraction.
 */
export async function runAgentOrchestrator(opts: {
  chatJid: string;
  group: RegisteredProject;
  workspacePath: string;
  isMain: boolean;
  sessionId?: string;
  codingCli?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  onOutput?: (output: ContainerOutput) => Promise<void>;
  onReply?: (text: string) => Promise<void>;
  // For workspace setup tool
  sendFn: (jid: string, text: string) => Promise<void>;
  createChannelFn: (fromJid: string, name: string) => Promise<string | null>;
  registerProjectFn: (jid: string, group: RegisteredProject) => void;
  isChannelAliveFn: (jid: string) => Promise<boolean>;
  registeredProjects: Record<string, RegisteredProject>;
}): Promise<string> {
  const openrouter = getOpenRouter();
  const model = getModelName();

  logger.info({ model, chatJid: opts.chatJid }, 'Starting agent orchestrator');

  const executorTool = buildExecutorTool(
    opts.group,
    opts.workspacePath,
    opts.chatJid,
    opts.isMain,
    opts.sessionId,
    opts.codingCli,
    opts.onOutput,
  );

  const workspaceTool = buildWorkspaceTool(
    opts.chatJid,
    opts.sendFn,
    opts.createChannelFn,
    opts.registerProjectFn,
    opts.isChannelAliveFn,
    opts.registeredProjects,
  );

  const systemPrompt = `You are TiClaw 🦀, a Discord-based coding agent orchestrator.
You manage tasks for the current repository "${opts.group.name}".

You have tools available to delegate work:
1. \`workspaceTool\`: Use this to set up (clone), update (git pull), or delete a GitHub repository workspace.
2. \`executorTool\`: Use this for ANY codebase task — coding, debugging, reviewing, AND answering questions about the repo (git branch, status, file contents, architecture, etc.).

IMPORTANT RULES:
1. When the user asks ANYTHING about the codebase or repository (e.g., "which branch?", "what changed?", "fix #123", "review the code"), you **MUST** call \`executorTool\`. You have NO direct access to the repo — only the executor does.
2. DO NOT try to write code, edit files, or answer repo questions yourself. Always delegate to \`executorTool\`.
3. When the user asks to clone or work on a new repo, use \`workspaceTool\` with operation 'setup'.
4. If you use a tool, do NOT also write a long reply. Let the tool output speak for itself.
5. Only answer directly (without tools) for greetings or questions unrelated to the codebase. Be concise.`;

  try {
    const result = await generateText({
      model: openrouter(model),
      system: systemPrompt,
      messages: opts.messages as ModelMessage[],
      tools: {
        workspaceTool,
        executorTool,
      },
      // Stop after tool execution — the executor is fire-and-forget,
      // no need for a second LLM round-trip that may timeout.
      stopWhen: [hasToolCall('executorTool'), hasToolCall('workspaceTool')],
      onStepFinish({ text, toolCalls }) {
        if (toolCalls.length > 0 && opts.onReply) {
          const names = toolCalls.map((t) => t.toolName).join(', ');
          opts.onReply(`🦀 Dispatching task to ${names}...`);
        }
      },
    });

    logger.info(
      {
        chatJid: opts.chatJid,
        text: result.text?.slice(0, 200),
        steps: result.steps.length,
        toolCalls: result.steps.flatMap((s) =>
          s.toolCalls.map((t) => t.toolName),
        ),
      },
      'Agent result',
    );

    if (result.text && result.text.trim()) {
      if (opts.onReply) await opts.onReply(result.text);
      return result.text;
    }

    // Fallback: tools ran but no final text — still notify the user
    const fallbackMsg = 'Task dispatched.';
    if (opts.onReply) await opts.onReply(fallbackMsg);
    return fallbackMsg;
  } catch (err: any) {
    logger.error({ err }, 'Agent generation failed');
    const fallback = `I encountered an error while thinking: ${err.message}`;
    if (opts.onReply) await opts.onReply(fallback);
    return fallback;
  }
}
