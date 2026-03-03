import fs from 'fs';
import path from 'path';

import {
  AC_CODING_CLI,
  ASSISTANT_NAME,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TRIGGER_PATTERN,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
  readSecrets,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { routeOutbound, routeOutboundFile, formatMessages } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import {
  AvailableGroup,
  Channel,
  NewMessage,
  RegisteredGroup,
} from './types.js';
import { AcWorkspace } from './executor/workspace.js';
import { TmuxBridge } from './executor/tmux-bridge.js';

// Define ChannelOpts locally as it was removed from registry.ts
export interface ChannelOpts {
  onMessage: (chatJid: string, msg: NewMessage) => void;
  onChatMetadata: (
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ) => void;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onGroupRegistered: (jid: string, group: RegisteredGroup) => void;
  onVerify?: (chatJid: string, url: string) => Promise<void>;
}

// Global state
let registeredGroups: Record<string, RegisteredGroup> = {};
const sessions: Record<string, string> = {}; // folder -> sessionId
const lastAgentTimestamp: Record<string, string> = {}; // chatJid -> iso
const channels: Channel[] = [];
const activeWorkspaces = new Map<string, AcWorkspace>(); // folder -> AcWorkspace
let messageLoopRunning = false;

// Forward declaration for recursion
async function runAgent(
  chatJid: string,
  prompt: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const group = registeredGroups[chatJid];
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
      if (output.newSessionId) {
        sessions[group.folder] = output.newSessionId;
        setSession(group.folder, output.newSessionId);
      }
      await onOutput(output);
    }
    : undefined;

  try {
    let output: ContainerOutput;

    if (isContainerRuntimeAvailable) {
      output = await runContainerAgent(
        group,
        {
          prompt,
          sessionId,
          groupFolder: group.folder,
          chatJid,
          isMain,
          assistantName: ASSISTANT_NAME,
          codingCli: AC_CODING_CLI,
        },
        (proc, containerName) =>
          queue.registerProcess(chatJid, proc, containerName, group.folder),
        wrappedOnOutput,
      );
    } else {
      logger.info({ group: group.name }, 'Using physical agent fallback');
      output = await runPhysicalAgent(
        group,
        {
          prompt,
          sessionId,
          chatJid,
          isMain,
          codingCli: AC_CODING_CLI,
        },
        wrappedOnOutput,
      );
    }

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error({ group: group.name, error: output.error }, 'Agent error');
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

// Create queue
const queue = new GroupQueue();

async function processMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return false;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const messages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);

  if (messages.length === 0) return true;

  const prompt = formatMessages(messages);

  // Update last timestamp BEFORE running to avoid loops on failure
  const newest = messages[messages.length - 1].timestamp;
  lastAgentTimestamp[chatJid] = newest;
  setRouterState(chatJid, newest);

  const result = await runAgent(chatJid, prompt, async (output) => {
    if (output.result) {
      await sendFn(chatJid, output.result);
    }
    if (output.status === 'success') {
      queue.notifyIdle(chatJid);
    }
  });

  return result === 'success';
}

queue.setProcessMessagesFn(processMessages);

export function getAvailableGroups(): AvailableGroup[] {
  const allChats = getAllChats();
  return allChats.map((chat) => ({
    jid: chat.jid,
    name: chat.name || chat.jid,
    lastActivity: chat.last_message_time,
    isRegistered: !!registeredGroups[chat.jid],
  }));
}

/** @internal - for tests only. */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  // Use DB helper to persist registration
  setRegisteredGroup(jid, group);
  // Update local cache
  registeredGroups[jid] = group;
  logger.info({ jid, folder: group.folder }, 'Group registered');
}

async function runPhysicalAgent(
  group: RegisteredGroup,
  input: {
    prompt: string;
    sessionId?: string;
    chatJid: string;
    isMain: boolean;
    codingCli?: string;
  },
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  let workspace = activeWorkspaces.get(group.folder);
  if (!workspace) {
    workspace = new AcWorkspace({
      id: group.folder,
      name: group.name,
      onFileAdded: async (filePath) => {
        await routeOutboundFile(
          channels,
          input.chatJid,
          filePath,
          '📸 New Snapshot',
        );
      },
      onSummary: async (summary) => {
        await sendFn(input.chatJid, `📝 **Delta Feed:** ${summary}`);
      },
    });
    await workspace.init();
    activeWorkspaces.set(group.folder, workspace);
  }

  const secrets = readSecrets();

  // Setup IPC input dir for physical agent
  const ipcInputDir = path.join(workspace.rootDir, 'ipc', 'input');
  fs.mkdirSync(ipcInputDir, { recursive: true });

  const agentRunnerDir = path.resolve(process.cwd(), 'container/agent-runner');

  // We need to ensure agent-runner is built
  if (!fs.existsSync(path.join(agentRunnerDir, 'dist/index.js'))) {
    throw new Error(
      'agent-runner not built. Run pnpm --filter agent-runner build',
    );
  }

  const bridge = new TmuxBridge(group.folder, async (data) => {
    if (onOutput && data.includes('---AQUACLAW_OUTPUT_START---')) {
      const parts = data.split('---AQUACLAW_OUTPUT_START---');
      for (const part of parts) {
        if (part.includes('---AQUACLAW_OUTPUT_END---')) {
          const jsonStr = part.split('---AQUACLAW_OUTPUT_END---')[0].trim();
          try {
            const output = JSON.parse(jsonStr);
            await onOutput(output);
          } catch (err) {
            // ignore parse errors for partial data
          }
        }
      }
    }
  });

  const command = `cd ${agentRunnerDir} && node dist/index.js`;
  await bridge.createSession(workspace.rootDir, command);

  const inputStr = JSON.stringify({
    ...input,
    groupFolder: workspace.rootDir,
    assistantName: ASSISTANT_NAME,
    secrets: secrets,
  });

  const tempInput = path.join(workspace.rootDir, 'input.json');
  fs.writeFileSync(tempInput, inputStr);

  // Send keys to tmux session to pipe the input file to the agent-runner
  await bridge.sendKeys(`cat ${tempInput} | node dist/index.js`);

  return { status: 'success', result: 'Physical session started in tmux' };
}

async function triggerVerification(
  chatJid: string,
  url: string,
): Promise<void> {
  const group = registeredGroups[chatJid];
  if (!group) return;

  let workspace = activeWorkspaces.get(group.folder);
  if (!workspace) {
    workspace = new AcWorkspace({
      id: group.folder,
      name: group.name,
      onFileAdded: async (filePath) => {
        await routeOutboundFile(
          channels,
          chatJid,
          filePath,
          '📸 Verification Snapshot',
        );
      },
    });
    await workspace.init();
    activeWorkspaces.set(group.folder, workspace);
  }

  await workspace.verify(url, 'manual-verify');
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;
  logger.debug('Starting message loop');

  while (messageLoopRunning) {
    try {
      const jids = Object.keys(registeredGroups);
      // Sort to find the most recent seen message
      const lastGlobalTs =
        Object.values(lastAgentTimestamp).sort().reverse()[0] || '';

      const { messages } = getNewMessages(jids, lastGlobalTs, ASSISTANT_NAME);

      for (const msg of messages) {
        const chatJid = msg.chat_jid;
        const group = registeredGroups[chatJid];

        if (!group) {
          logger.debug({ chatJid }, 'Skipping message from unregistered group');
          continue;
        }

        // Track last seen timestamp to avoid re-processing on restart
        if (
          !lastAgentTimestamp[chatJid] ||
          msg.timestamp > lastAgentTimestamp[chatJid]
        ) {
          lastAgentTimestamp[chatJid] = msg.timestamp;
        }

        if (msg.is_from_me) continue;

        // Trigger logic
        const triggerMatch = TRIGGER_PATTERN.test(msg.content);
        if (group.isMain || !group.requiresTrigger || triggerMatch) {
          logger.info(
            { chatJid, sender: msg.sender_name },
            'Enqueuing agent request',
          );
          queue.enqueueMessageCheck(chatJid);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}

function loadState(): void {
  // Load registered groups
  const groups = getAllRegisteredGroups();
  for (const [jid, group] of Object.entries(groups)) {
    registeredGroups[jid] = group;
  }
  logger.info({ count: Object.keys(registeredGroups).length }, 'Groups loaded');

  // Load sessions
  const dbSessions = getAllSessions();
  for (const [folder, sessionId] of Object.entries(dbSessions)) {
    sessions[folder] = sessionId;
  }
  logger.info({ count: Object.keys(sessions).length }, 'Sessions loaded');

  // Load router state (last seen timestamps)
  for (const jid of Object.keys(registeredGroups)) {
    const timestamp = getRouterState(jid);
    if (timestamp) {
      lastAgentTimestamp[jid] = timestamp;
    }
  }
}

function handleChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  storeChatMetadata(chatJid, timestamp, name, channel, isGroup);
}

/**
 * Check for messages that arrived while AquaClaw was offline.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

let isContainerRuntimeAvailable = false;

function ensureContainerSystemRunning(): void {
  isContainerRuntimeAvailable = ensureContainerRuntimeRunning();
  if (isContainerRuntimeAvailable) {
    cleanupOrphans();
  }
}

// Global send function for use in processMessages
let sendFn: (jid: string, text: string) => Promise<void>;

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Channel callbacks (shared by all channels)
  const channelOpts: ChannelOpts = {
    onMessage: (_chatJid: string, msg: NewMessage) => storeMessage(msg),
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => handleChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
    onGroupRegistered: (jid: string, group: RegisteredGroup) =>
      registerGroup(jid, group),
    onVerify: async (chatJid, url) => {
      await triggerVerification(chatJid, url);
    },
  };

  const CHANNEL_CONNECT_TIMEOUT = 15_000; // 15s per channel
  const registeredChannelNames = getRegisteredChannelNames();
  for (const name of registeredChannelNames) {
    const factory = getChannelFactory(name);
    if (factory) {
      const channel = factory(channelOpts as any);
      if (channel) {
        try {
          logger.info({ channel: name }, 'Connecting channel');
          await Promise.race([
            channel.connect(),
            new Promise<never>((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error(
                      `Channel ${name} connect timed out after ${CHANNEL_CONNECT_TIMEOUT / 1000}s`,
                    ),
                  ),
                CHANNEL_CONNECT_TIMEOUT,
              ),
            ),
          ]);
          channels.push(channel);
        } catch (err) {
          logger.error(
            { channel: name, err },
            'Failed to connect channel — skipping',
          );
        }
      }
    }
  }

  // Define global sendFn
  sendFn = async (jid: string, text: string) => {
    await routeOutbound(channels, jid, text);
    const ts = new Date().toISOString();
    lastAgentTimestamp[jid] = ts;
    setRouterState(jid, ts);
  };

  // Initial recovery and start loop
  recoverPendingMessages();
  startMessageLoop();

  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (chatJid, proc, containerName, groupFolder) =>
      queue.registerProcess(chatJid, proc, containerName, groupFolder),
    sendMessage: sendFn,
  });

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    messageLoopRunning = false;
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info(`AquaClaw running (trigger: @${ASSISTANT_NAME})`);
}

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
  new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start AquaClaw');
    process.exit(1);
  });
}
