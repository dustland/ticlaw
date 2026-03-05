import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  TC_CODING_CLI,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './core/config.js';
import {
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './core/db.js';
import { resolveGroupFolderPath } from './executor/group-folder.js';
import { logger } from './core/logger.js';
import { RegisteredProject, ScheduledTask } from './core/types.js';
import { runAgentOrchestrator } from './agent.js';

export interface SchedulerDependencies {
  registeredProjects: () => Record<string, RegisteredProject>;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

// Simple map to lock concurrent scheduled task execution per channel
const activeTaskLocks = new Map<string, Promise<void>>();

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredProjects();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  let result: string | null = null;
  let error: string | null = null;

  try {
    // We treat the scheduled prompt as a system/user pseudo-message to kick off the agent
    const aiMessages = [
      {
        role: 'user' as const,
        content: `[CRON TASK TRIGGERED]\n${task.prompt}`,
      },
    ];

    await runAgentOrchestrator({
      chatJid: task.chat_jid,
      group,
      workspacePath: groupDir,
      isMain: !!group.isMain,
      codingCli: TC_CODING_CLI,
      sessionId: `cron_${task.id.replace(/[^a-zA-Z0-9]/g, '_')}`,
      messages: aiMessages,
      // Minimal mocked functions for the orchestrator, since we're just running a background job
      sendFn: deps.sendMessage,
      createChannelFn: async () => null,
      registerProjectFn: () => {},
      isChannelAliveFn: async () => true,
      registeredProjects: groups,
      onReply: async (text) => {
        await deps.sendMessage(task.chat_jid, text);
      },
      onOutput: async (output) => {
        if (output.result) {
          result = output.result;
          await deps.sendMessage(task.chat_jid, output.result);
        }
        if (output.status === 'error') {
          error = output.error || 'Unknown error';
        }
      },
    });

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  let nextRun: string | null = null;
  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    nextRun = interval.next().toISOString();
  } else if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    nextRun = new Date(Date.now() + ms).toISOString();
  }
  // 'once' tasks have no next run

  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? (result as string).slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        // Prevent overlapping scheduled runs per channel to avoid confusing the agent
        if (!activeTaskLocks.has(currentTask.chat_jid)) {
          const promise = runTask(currentTask, deps).finally(() => {
            activeTaskLocks.delete(currentTask.chat_jid);
          });
          activeTaskLocks.set(currentTask.chat_jid, promise);
        } else {
          logger.debug(
            { taskId: task.id },
            'Skipping overlapping scheduled task execution',
          );
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
