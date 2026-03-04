import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  AC_CODING_CLI,
  ASSISTANT_NAME,
  AQUACLAW_HOME,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TRIGGER_PATTERN,
} from './core/config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  getAllChats,
  getAllRegisteredProjects,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredProject,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  getRecentMessages,
} from './core/db.js';
import { logger } from './core/logger.js';
import { routeOutbound, routeOutboundFile, routeSetTyping } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import {
  AvailableProject,
  Channel,
  NewMessage,
  RegisteredProject,
} from './core/types.js';

import { runAgentOrchestrator, getModelName } from './agent.js';
import type { ContainerOutput } from './core/types.js';
import { readEnvFile } from './core/env.js';

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
  registeredProjects: () => Record<string, RegisteredProject>;
  onGroupRegistered: (jid: string, group: RegisteredProject) => void;
}

// Global state
let registeredProjects: Record<string, RegisteredProject> = {};
const sessions: Record<string, string> = {}; // folder -> sessionId
const lastAgentTimestamp: Record<string, string> = {}; // chatJid -> iso
const channels: Channel[] = [];

/** Check if a registered JID still points to a live channel. */
async function isChannelAlive(jid: string): Promise<boolean> {
  for (const ch of channels) {
    if (ch.ownsJid(jid) && ch.channelExists) {
      return ch.channelExists(jid);
    }
  }
  return false;
}

let messageLoopRunning = false;

// Simple mutex per channel to prevent overlapping agent runs
const activeAgentLocks = new Map<string, Promise<any>>();

async function processMessages(chatJid: string): Promise<boolean> {
  let group = registeredProjects[chatJid];
  if (!group) return false;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const messages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);

  if (messages.length === 0) return true;

  // Update last timestamp BEFORE running to avoid loops on failure
  const newest = messages[messages.length - 1].timestamp;
  lastAgentTimestamp[chatJid] = newest;
  setRouterState(chatJid, newest);

  // Extract raw text from messages for agent thinking
  const rawText = messages.map((m) => m.content).join('\n');

  const recentMessages = getRecentMessages(chatJid, 10);
  let contextText = rawText;
  if (recentMessages.length > messages.length) {
    const historyMsgs = recentMessages.slice(
      0,
      recentMessages.length - messages.length,
    );
    const historyText = historyMsgs
      .map((m) => `${m.sender_name || 'User'}: ${m.content}`)
      .join('\n');
    contextText = `[Conversation History]\n${historyText}\n\n[Latest Message]\n${rawText}`;
  }

  logger.info(
    { chatJid, messageCount: messages.length, rawText: rawText.slice(0, 200) },
    'processMessages: starting',
  );

  try {
    // Show typing indicator while we process
    routeSetTyping(channels, chatJid, true);

    // Check if we have a valid workspace for this group
    const workspace = getFactoryPath(group);
    const hasWorkspace = fs.existsSync(workspace);
    logger.info(
      { chatJid, workspace, hasWorkspace },
      'processMessages: workspace check',
    );

    const aiMessages = messages.map((m) => ({
      role: (m.sender_name === ASSISTANT_NAME ? 'assistant' : 'user') as
        | 'assistant'
        | 'user',
      content: m.content,
    }));

    try {
      if (!registeredProjects[chatJid] && !hasWorkspace) {
        logger.info(
          { chatJid },
          'Creating temporary context for unregistered chat',
        );
        group = {
          name: 'unknown',
          folder: 'unknown',
          trigger: `@${ASSISTANT_NAME}`,
          added_at: new Date().toISOString(),
          requiresTrigger: true,
          isMain: false,
        };
      }

      await runAgentOrchestrator({
        chatJid,
        group,
        workspacePath: workspace,
        isMain: !!group.isMain,
        sessionId: chatJid.replace(/[^a-zA-Z0-9]/g, '_'),
        messages: aiMessages,
        sendFn,
        createChannelFn,
        registerProjectFn: registerProject,
        isChannelAliveFn: isChannelAlive,
        registeredProjects,
        onReply: async (text) => {
          await sendFn(chatJid, text);
        },
        onOutput: async (output) => {
          if (output.result) {
            let text = output.result;
            const embeds: any[] = [];
            const embedRegex =
              /(?:```(?:json)?\s*)?<discord_embed>\s*([\s\S]*?)\s*<\/discord_embed>(?:\s*```)?/g;
            let match;
            while ((match = embedRegex.exec(text)) !== null) {
              try {
                const parsed = JSON.parse(match[1]);
                embeds.push(parsed);
                text = text.replace(match[0], '').trim();
              } catch (e) {
                logger.warn({ err: e, txt: match[1] }, 'Failed to parse JSON');
              }
            }
            if (text.trim() || embeds.length > 0) {
              await sendFn(
                chatJid,
                text,
                embeds.length > 0 ? { embeds } : undefined,
              );
            }
          }
          if (output.status === 'success') {
            // idle notification handled conceptually by lock release
          }
        },
      });

      return true;
    } catch (err: any) {
      logger.error({ err }, 'Agent orchestrator failed');
      await sendFn(
        chatJid,
        `❌ **Agent Execution Failed**\n\`\`\`\n${err.message}\n\`\`\``,
      );
      return false;
    }
  } finally {
    // Ensure typing indicator is always stopped
    routeSetTyping(channels, chatJid, false);
  }
}

/** Resolve the workspace directory for a group. */
function getFactoryPath(group: RegisteredProject): string {
  return path.join(AQUACLAW_HOME, 'factory', group.folder);
}

export function getAvailableProjects(): AvailableProject[] {
  const allChats = getAllChats();
  return allChats.map((chat) => ({
    jid: chat.jid,
    name: chat.name || chat.jid,
    lastActivity: chat.last_message_time,
    isRegistered: !!registeredProjects[chat.jid],
  }));
}

/** @internal - for tests only. */
export function _setRegisteredProjects(
  groups: Record<string, RegisteredProject>,
): void {
  registeredProjects = groups;
}

function registerProject(jid: string, group: RegisteredProject): void {
  setRegisteredProject(jid, group);
  registeredProjects[jid] = group;
  logger.info({ jid, folder: group.folder }, 'Group registered');
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;
  logger.debug('Starting message loop');

  // Track what the message loop has already SEEN (to avoid re-enqueuing).
  // This is separate from lastAgentTimestamp which tracks what processMessages
  // has actually PROCESSED.
  const lastLoopTimestamp: Record<string, string> = {};

  while (messageLoopRunning) {
    try {
      const jids = Object.keys(registeredProjects);
      const lastGlobalTs =
        Object.values(lastLoopTimestamp).sort().reverse()[0] ||
        Object.values(lastAgentTimestamp).sort().reverse()[0] ||
        '';

      const { messages } = getNewMessages(jids, lastGlobalTs, ASSISTANT_NAME);

      for (const msg of messages) {
        const chatJid = msg.chat_jid;
        const group = registeredProjects[chatJid];

        if (!group) {
          logger.debug({ chatJid }, 'Skipping message from unregistered group');
          continue;
        }

        // Track that the loop has seen this message (prevents re-enqueue)
        if (
          !lastLoopTimestamp[chatJid] ||
          msg.timestamp > lastLoopTimestamp[chatJid]
        ) {
          lastLoopTimestamp[chatJid] = msg.timestamp;
        }

        if (msg.is_from_me) continue;

        const triggerMatch = TRIGGER_PATTERN.test(msg.content);
        if (group.isMain || !group.requiresTrigger || triggerMatch) {
          logger.info(
            { chatJid, sender: msg.sender_name },
            'Trigger matched, checking locks',
          );

          if (!activeAgentLocks.has(chatJid)) {
            const agentPromise = processMessages(chatJid).finally(() => {
              activeAgentLocks.delete(chatJid);
            });
            activeAgentLocks.set(chatJid, agentPromise);
          } else {
            logger.debug(
              { chatJid },
              'Agent already running for this channel, skipping enqueue',
            );
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}

function loadState(): void {
  const groups = getAllRegisteredProjects();
  for (const [jid, group] of Object.entries(groups)) {
    registeredProjects[jid] = group;
  }
  logger.info(
    { count: Object.keys(registeredProjects).length },
    'Groups loaded',
  );

  const dbSessions = getAllSessions();
  for (const [folder, sessionId] of Object.entries(dbSessions)) {
    sessions[folder] = sessionId;
  }
  logger.info({ count: Object.keys(sessions).length }, 'Sessions loaded');

  for (const jid of Object.keys(registeredProjects)) {
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

function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredProjects)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: replaying unprocessed messages',
      );
      if (!activeAgentLocks.has(chatJid)) {
        const agentPromise = processMessages(chatJid).finally(() => {
          activeAgentLocks.delete(chatJid);
        });
        activeAgentLocks.set(chatJid, agentPromise);
      }
    }
  }
}

let sendFn: (
  jid: string,
  text: string,
  options?: { embeds?: any[] },
) => Promise<void>;
let createChannelFn: (fromJid: string, name: string) => Promise<string | null>;

async function main(): Promise<void> {
  initDatabase();
  logger.info('Database initialized');
  loadState();

  const channelOpts: ChannelOpts = {
    onMessage: (_chatJid: string, msg: NewMessage) => storeMessage(msg),
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => handleChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredProjects: () => registeredProjects,
    onGroupRegistered: (jid: string, group: RegisteredProject) =>
      registerProject(jid, group),
  };

  const CHANNEL_CONNECT_TIMEOUT = 15_000;
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

  sendFn = async (jid: string, text: string, options?: { embeds?: any[] }) => {
    await routeOutbound(channels, jid, text, options);
    const ts = new Date().toISOString();
    lastAgentTimestamp[jid] = ts;
    setRouterState(jid, ts);
  };

  createChannelFn = async (
    fromJid: string,
    channelName: string,
  ): Promise<string | null> => {
    for (const ch of channels) {
      if (ch.ownsJid(fromJid) && ch.createChannel) {
        return ch.createChannel(fromJid, channelName);
      }
    }
    return null;
  };

  recoverPendingMessages();
  startMessageLoop();

  startSchedulerLoop({
    registeredProjects: () => registeredProjects,
    sendMessage: sendFn,
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    // Wait for all active agents to finish (up to 10s)
    const activePromises = Array.from(activeAgentLocks.values());
    if (activePromises.length > 0) {
      logger.info(
        { draining: activePromises.length },
        'Waiting for active agents to finish...',
      );
      await Promise.race([
        Promise.allSettled(activePromises),
        new Promise((r) => setTimeout(r, 10000)),
      ]);
    }
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
