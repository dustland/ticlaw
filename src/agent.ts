import { generateText, stepCountIs, type ModelMessage } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { ContainerOutput } from './core/types.js';
import { buildSessionTools } from './tools/executor.js';
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
 * Lightweight LLM call to interpret a raw Gemini screen and format for Discord.
 * Used by the async idle callback — no tools, just text in → text out.
 */
async function interpretScreen(
  screenContent: string,
  groupName: string,
): Promise<string> {
  const openrouter = getOpenRouter();
  const model = getModelName();

  const interpretPrompt = `You are formatting a terminal screen capture for Discord.

The terminal shows output from Gemini CLI (an AI coding agent) working on the "${groupName}" repository.
The GitHub repository is at: https://github.com/${groupName}

## Your task

Extract the meaningful response from the screen and format it for Discord.

- Find text after the last "✦" marker — that's the agent's answer.
- Ignore TUI chrome (status bars, separators, "Type your message", spinners, tool call boxes).
- Include clickable GitHub links for commits, PRs, issues, and files.
- Use Discord markdown: **bold**, \`code\`, > blockquotes, bullet lists.
- Keep it concise and scannable.

## Raw screen content

${screenContent}`;

  try {
    const result = await generateText({
      model: openrouter(model),
      prompt: interpretPrompt,
    });

    return result.text || '🦀 Task completed but could not extract response.';
  } catch (err) {
    logger.error({ err }, 'Screen interpretation failed');
    return '🦀 Task completed. Check the workspace agent for details.';
  }
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
  onOutput?: (output: ContainerOutput) => Promise<void> | void;
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

  // Async callback: when Gemini becomes idle after a prompt,
  // interpret the screen and deliver the formatted result to Discord.
  const onIdleCallback = async (screen: string) => {
    logger.info(
      { chatJid: opts.chatJid, screenLength: screen.length },
      'Idle callback fired, interpreting screen',
    );

    try {
      const formatted = await interpretScreen(screen, opts.group.name);
      logger.info(
        { chatJid: opts.chatJid, responseLength: formatted.length },
        'Interpreted response, sending to Discord',
      );
      if (opts.onReply) await opts.onReply(formatted);
    } catch (err) {
      logger.error({ err, chatJid: opts.chatJid }, 'Idle callback failed');
      if (opts.onReply) {
        await opts.onReply(
          '🦀 Task completed. Check the workspace agent for details.',
        );
      }
    }
  };

  // Progress callback: fires periodically during long tasks.
  // Uses a lightweight LLM call to summarize the current screen into a status update.
  const onProgressCallback = async (screen: string, elapsedMs: number) => {
    const elapsed = Math.round(elapsedMs / 1000);
    logger.info({ chatJid: opts.chatJid, elapsed }, 'Progress update');

    try {
      const result = await generateText({
        model: openrouter(model),
        prompt: `You are summarizing what an AI coding agent is currently doing, based on its terminal screen capture.

Return a SINGLE short sentence (max 15 words) describing the current activity. Start with a verb.
Examples: "Reading seed-data.ts to find legacy table references", "Running unit tests", "Editing auth.ts to fix the login bug", "Searching for open issues in the repository"

If unclear, just say "Working on the task".

Raw screen:
${screen}`,
      });

      const summary = result.text?.trim() || 'Working on the task';
      const statusMsg = `⏳ (${elapsed}s) ${summary}`;

      if (opts.onReply) {
        await opts.onReply(statusMsg);
      }
    } catch (err) {
      logger.warn({ err }, 'Progress summarization failed');
    }
  };

  const { captureSessionTool, sendToSessionTool } = buildSessionTools(
    opts.group,
    opts.workspacePath,
    opts.chatJid,
    opts.isMain,
    opts.sessionId,
    opts.codingCli,
    opts.onOutput,
    onIdleCallback,
    onProgressCallback,
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
You manage tasks for the repository "${opts.group.name}" by delegating work to an AI coding agent (Gemini CLI) running in a tmux terminal session.

## CRITICAL: Always delegate

For ANY user message that is not a simple greeting (like "hi" or "thanks"), you MUST delegate to Gemini. NEVER answer user questions yourself. You do not have access to the codebase, the machine, system resources, git, or anything else — only Gemini does.

If you find yourself about to type an answer without having called any tools, STOP and delegate to Gemini instead.

## Your tools

1. \`captureSessionTool\`: Reads the current terminal screen. Use \`waitForIdle=true\` to wait until Gemini is ready.
2. \`sendToSessionTool\`: Types text into Gemini and presses Enter. **After sending, a background monitor automatically watches Gemini and delivers the result to Discord when done.** You do NOT need to capture the result yourself.
3. \`workspaceTool\`: Clone, update, or delete a repository workspace.

## Understanding the session

The tmux session runs **Gemini CLI** — an AI coding agent with its own TUI. You communicate with Gemini by typing natural language prompts. Gemini reads the codebase, runs tools, and responds.

**You do NOT run shell commands directly.** Always send natural language like "What was the last commit?" or "Fix the bug in auth.ts", never raw commands like "git log".

### Session lifecycle (cold start)

1. **Bare shell** (0-2s): Shell prompt with \`gemini -y\` being launched. NOT ready.
2. **Loading** (2-20s): "Loading extension..." messages. NOT ready.
3. **Idle** (after ~20s): "Type your message" visible. NOW ready.

## Workflow

For any user message (except greetings):

1. **Capture** the screen to check Gemini's state.
2. **If not ready** (shell prompt, loading, spinners): use \`captureSessionTool\` with waitForIdle=true to wait.
3. **Send** the user's request via \`sendToSessionTool\`. Send ONCE only.
4. **Acknowledge**: Tell the user their task has been sent. The background monitor will deliver Gemini's response automatically.

That's it — you do NOT need to poll or capture after sending. The async monitor handles delivery.

## Rules

1. NEVER answer questions yourself. ALWAYS delegate to Gemini.
2. NEVER send raw shell commands. Always natural language.
3. NEVER re-send a prompt.
4. NEVER ask "would you like me to proceed?" — just do it.

## Formatting your acknowledgment

When acknowledging a sent task, briefly confirm what you sent. For example:
- "🦀 Asked Gemini to check the last commit. I'll post the answer shortly."
- "🦀 Sent your bug fix request to Gemini. Will update you when it's done."`;

  try {
    const result = await generateText({
      model: openrouter(model),
      system: systemPrompt,
      messages: opts.messages as ModelMessage[],
      tools: {
        workspaceTool,
        captureSessionTool,
        sendToSessionTool,
      },
      stopWhen: stepCountIs(250),
      onStepFinish({ toolCalls }) {
        if (toolCalls.length > 0) {
          const names = toolCalls.map((t) => t.toolName).join(', ');
          logger.info(
            { chatJid: opts.chatJid, tools: names },
            'Tool dispatched',
          );
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

    // Fallback: tools ran successfully but no final text
    const fallbackMsg = '🦀 Task sent to workspace agent.';
    if (opts.onReply) await opts.onReply(fallbackMsg);
    return fallbackMsg;
  } catch (err: any) {
    logger.error({ err }, 'Agent generation failed');
    const fallback = `I encountered an error while thinking: ${err.message}`;
    if (opts.onReply) await opts.onReply(fallback);
    return fallback;
  }
}
