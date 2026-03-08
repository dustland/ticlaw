import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  TC_CODING_CLI,
  ASSISTANT_NAME,
  TICLAW_HOME,
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
import {
  createPackage,
  listPackages,
  lockMind,
  mindStatus,
  recordUserInteraction,
  rollbackPackage,
  unlockMind,
} from './core/mind.js';
import { logger } from './core/logger.js';
import {
  routeOutbound,
  routeOutboundFile,
  routeSetTyping,
  routeSendReturningId,
  routeEditMessage,
} from './router.js';
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

  // Natural conversation updates mind (non-blocking simple updater)
  const latestMsg = messages[messages.length - 1];
  if (latestMsg?.content && !latestMsg.content.trim().startsWith('/mind')) {
    try {
      recordUserInteraction({
        chat_jid: chatJid,
        channel: chatJid.startsWith('dc:') ? 'discord' : chatJid.startsWith('tg:') ? 'telegram' : undefined,
        role: 'user',
        content: latestMsg.content,
        timestamp: latestMsg.timestamp,
        sender: latestMsg.sender,
        sender_name: latestMsg.sender_name,
      });
    } catch (err) {
      logger.warn({ err }, 'mind updater failed (ignored)');
    }
  }

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

    // Mind commands (text-only control plane)
    const latestText = messages[messages.length - 1]?.content?.trim() || '';
    if (latestText.startsWith('/mind')) {
      const parts = latestText.split(/\s+/);
      const cmd = parts[1] || 'status';

      if (cmd === 'status') {
        const state = mindStatus();
        await sendFn(
          chatJid,
          `🧠 Mind status\n- version: ${state.version}\n- lifecycle: ${state.lifecycle}\n- persona: ${JSON.stringify(state.persona)}`,
        );
        return true;
      }

      if (cmd === 'lock') {
        const state = lockMind();
        await sendFn(chatJid, `✅ Mind locked at version ${state.version}`);
        return true;
      }

      if (cmd === 'unlock') {
        const state = unlockMind();
        await sendFn(chatJid, `✅ Mind unlocked (lifecycle=${state.lifecycle})`);
        return true;
      }

      if (cmd === 'package') {
        const sub = parts[2] || 'create';
        if (sub === 'create') {
          const pkg = createPackage('Created via /mind package create');
          await sendFn(chatJid, `📦 Mind package created: v${pkg.version} (${pkg.id})`);
          return true;
        }
        if (sub === 'list') {
          const pkgs = listPackages(5);
          const lines = pkgs.map((p) => `- v${p.version} [${p.lifecycle}] ${p.id}`).join('\n');
          await sendFn(chatJid, `📚 Recent mind packages\n${lines || '(empty)'}`);
          return true;
        }
      }

      if (cmd === 'rollback') {
        const version = Number(parts[2]);
        if (!Number.isFinite(version)) {
          await sendFn(chatJid, 'Usage: /mind rollback <version>');
          return true;
        }
        const state = rollbackPackage(version);
        if (!state) {
          await sendFn(chatJid, `❌ Mind package version ${version} not found`);
          return true;
        }
        await sendFn(chatJid, `↩️ Rolled back to mind version ${state.version}`);
        return true;
      }
    }

    // Check if we have a valid workspace for this group
    const workspace = getFactoryPath(group);
    const hasWorkspace = fs.existsSync(workspace);
    logger.info(
      { chatJid, workspace, hasWorkspace },
      'processMessages: workspace check',
    );

    const aiMessages = recentMessages.map((m) => ({
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
        codingCli: TC_CODING_CLI,
        sessionId: sessions[group.folder],
        messages: aiMessages,
        sendFn,
        createChannelFn,
        registerProjectFn: registerProject,
        isChannelAliveFn: isChannelAlive,
        registeredProjects,
        onReply: async (text) => {
          await sendFn(chatJid, text);
        },
        onOutput: (() => {
          // Streaming consolidation: accumulate text, send one message,
          // then edit it as more chunks arrive (debounced).
          const streamBuf = {
            text: '',
            messageId: null as string | null,
            timer: null as ReturnType<typeof setTimeout> | null,
          };

          const EDIT_DEBOUNCE_MS = 1500;
          const MAX_MSG_LENGTH = 1900; // leave 100 char headroom vs 2000 limit

          const flushEdit = async () => {
            streamBuf.timer = null;
            if (!streamBuf.messageId || !streamBuf.text) return;
            try {
              await routeEditMessage(
                channels,
                chatJid,
                streamBuf.messageId,
                streamBuf.text,
              );
            } catch (err) {
              logger.warn({ err }, 'Failed to edit streaming message');
            }
          };

          const scheduleEdit = () => {
            if (streamBuf.timer) clearTimeout(streamBuf.timer);
            streamBuf.timer = setTimeout(() => {
              flushEdit().catch(() => {});
            }, EDIT_DEBOUNCE_MS);
          };

          return async (output: ContainerOutput) => {
            // Capture Gemini CLI session ID for future --resume
            if (output.newSessionId) {
              sessions[group.folder] = output.newSessionId;
              setSession(group.folder, output.newSessionId);
              logger.info(
                { folder: group.folder, sessionId: output.newSessionId },
                'Captured new Gemini CLI session ID',
              );
              // Show typing while workspace agent is working
              routeSetTyping(channels, chatJid, true);
              return;
            }

            if (output.result) {
              let text = output.result;

              // Extract <discord_embed> blocks and send them as separate messages
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
                  logger.warn(
                    { err: e, txt: match[1] },
                    'Failed to parse embed JSON',
                  );
                }
              }
              if (embeds.length > 0) {
                await sendFn(chatJid, '', { embeds });
              }

              if (!text.trim()) return;

              // If accumulated text would exceed limit, finalize current message
              if (
                streamBuf.messageId &&
                streamBuf.text.length + text.length > MAX_MSG_LENGTH
              ) {
                if (streamBuf.timer) clearTimeout(streamBuf.timer);
                await flushEdit();
                // Reset for a new message
                streamBuf.text = '';
                streamBuf.messageId = null;
              }

              streamBuf.text += (streamBuf.text ? '\n' : '') + text;

              if (!streamBuf.messageId) {
                // First chunk: send a new message and capture its ID
                const msgId = await routeSendReturningId(
                  channels,
                  chatJid,
                  streamBuf.text,
                );
                if (msgId) {
                  streamBuf.messageId = msgId;
                } else {
                  // Fallback: channel doesn't support edit, just send normally
                  await sendFn(chatJid, streamBuf.text);
                  streamBuf.text = '';
                }
              } else {
                // Subsequent chunks: debounce an edit
                scheduleEdit();
              }
            }

            if (output.status === 'error' && output.error) {
              // If exit code 42 (stale session), clear the stored session
              // so the next invocation starts fresh
              if (output.error.includes('code 42')) {
                delete sessions[group.folder];
                logger.info(
                  { folder: group.folder },
                  'Cleared stale Gemini CLI session',
                );
              }
              streamBuf.text +=
                (streamBuf.text ? '\n' : '') +
                `❌ Executor error: ${output.error}`;
              if (streamBuf.timer) clearTimeout(streamBuf.timer);
              if (streamBuf.messageId) {
                await flushEdit();
              } else {
                await sendFn(chatJid, streamBuf.text);
                streamBuf.text = '';
              }
              // Stop typing on error
              routeSetTyping(channels, chatJid, false);
            }

            // Stop typing on completion (final result event has status but no text)
            if (output.status === 'success' && !output.result) {
              routeSetTyping(channels, chatJid, false);
            }
          };
        })(),
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
  return path.join(TICLAW_HOME, 'factory', group.folder);
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
  // Ensure a chats row exists for this JID before registering,
  // so that subsequent message storage doesn't fail with FK constraint.
  storeChatMetadata(jid, new Date().toISOString(), group.name);
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
    // Store bot response so conversation history includes assistant turns
    if (text.trim()) {
      storeMessage({
        id: `bot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        chat_jid: jid,
        sender: ASSISTANT_NAME,
        sender_name: ASSISTANT_NAME,
        content: text,
        timestamp: ts,
        is_from_me: true,
        is_bot_message: true,
      });
    }
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
    await Promise.allSettled(channels.map((ch) => ch.disconnect()));
    messageLoopRunning = false;
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info(`TiClaw running (trigger: @${ASSISTANT_NAME})`);
}

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start TiClaw');
    process.exit(1);
  });
}
