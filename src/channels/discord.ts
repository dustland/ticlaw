import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
  ThreadChannel,
  AnyThreadChannel,
} from 'discord.js';
import { ProxyAgent } from 'undici';
import { HttpsProxyAgent } from 'https-proxy-agent';
import https from 'node:https';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../core/config.js';
import { readEnvFile } from '../core/env.js';
import { logger } from '../core/logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredProject,
} from '../core/types.js';

export interface DiscordChannelOpts extends ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredProjects: () => Record<string, RegisteredProject>;
  onGroupRegistered?: (jid: string, group: RegisteredProject) => void;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private originalHttpsAgent: https.Agent | null = null;

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const envVars = readEnvFile([
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'http_proxy',
      'https_proxy',
    ]);
    const proxyUrl =
      process.env.HTTPS_PROXY ||
      process.env.HTTP_PROXY ||
      envVars.HTTPS_PROXY ||
      envVars.HTTP_PROXY ||
      envVars.http_proxy ||
      envVars.https_proxy;

    const clientOptions: any = {
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    };

    if (proxyUrl) {
      logger.info(
        { proxy: proxyUrl },
        'Discord: Configuring proxy for REST and Gateway',
      );

      // Agent for REST API (undici-based fetch)
      clientOptions.rest = {
        agent: new ProxyAgent(proxyUrl),
      };

      // Gateway WebSocket proxy: discord.js v14's @discordjs/ws uses the `ws`
      // package on Node.js, which calls https.request() without an explicit
      // agent. Node falls back to https.globalAgent for the WebSocket upgrade
      // request. By replacing it with an HttpsProxyAgent, all WSS connections
      // (including the Discord Gateway) are routed through the proxy.
      const agent = new HttpsProxyAgent(proxyUrl);
      this.originalHttpsAgent = https.globalAgent;
      https.globalAgent = agent as unknown as https.Agent;
      logger.info('Discord: Set https.globalAgent for Gateway proxy');
    }

    this.client = new Client(clientOptions);

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Legacy: /claw is deprecated — the agent handles all messages now.
      // If someone types /claw, treat it as a normal message to the agent.
      if (content.startsWith('/claw')) {
        content = content.replace(/^\/claw\s*/, '').trim();
        if (!content) {
          await message.reply(
            'Just @mention me with your task! e.g. `@TiClaw fix #198`',
          );
          return;
        }
        // Prepend trigger so it gets processed
        content = `@${ASSISTANT_NAME} ${content}`;
      }

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        if (message.channel.isThread()) {
          chatName = `${message.guild.name} #${(message.channel as AnyThreadChannel).parent?.name} > ${message.channel.name}`;
        } else {
          const textChannel = message.channel as TextChannel;
          chatName = `${message.guild.name} #${textChannel.name}`;
        }
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle attachments
      if (message.attachments.size > 0) {
        const attachmentDescriptions = [...message.attachments.values()].map(
          (att) => {
            const contentType = att.contentType || '';
            if (contentType.startsWith('image/')) {
              return `[Image: ${att.name || 'image'}]`;
            } else if (contentType.startsWith('video/')) {
              return `[Video: ${att.name || 'video'}]`;
            } else if (contentType.startsWith('audio/')) {
              return `[Audio: ${att.name || 'audio'}]`;
            } else {
              return `[File: ${att.name || 'file'}]`;
            }
          },
        );
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // Check if this channel is a registered group
      let group = this.opts.registeredProjects()[chatJid];

      // Auto-register channel when bot is @mentioned in an unregistered channel
      if (!group) {
        // Only auto-register if the bot was mentioned (not random chatter)
        if (!TRIGGER_PATTERN.test(content)) {
          logger.debug(
            { chatJid, chatName },
            'Message from unregistered channel (no bot mention)',
          );
          return;
        }

        // Auto-register this channel
        logger.info(
          { chatJid, chatName },
          'Auto-registering channel on bot mention',
        );

        const channelName =
          message.channel instanceof TextChannel
            ? (message.channel as TextChannel).name
            : message.channel.isThread()
              ? message.channel.name
              : `dm-${sender}`;

        const newGroup: RegisteredProject = {
          name: channelName,
          folder: channelName,
          trigger: `@${ASSISTANT_NAME}`,
          added_at: new Date().toISOString(),
          requiresTrigger: false,
          isMain: false,
        };

        if (this.opts.onGroupRegistered) {
          this.opts.onGroupRegistered(chatJid, newGroup);
        }

        group = newGroup;
        logger.info({ chatJid, channelName }, 'Channel auto-registered');
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName, content },
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Discord login timed out (30s)'));
      }, 30000);

      this.client!.once(Events.ClientReady, (readyClient) => {
        clearTimeout(timeout);
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        resolve();
      });

      this.client!.login(this.botToken).catch((err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    options?: { embeds?: any[] },
  ): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const sendable = channel as TextChannel | ThreadChannel;

      logger.info(
        {
          jid,
          textLength: text.length,
          embeds: options?.embeds?.length,
          rawContent: text,
        },
        'Discord sending message payload',
      );

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await sendable.send({
          content: text === '' ? undefined : text,
          embeds: options?.embeds,
        });
      } else {
        // Only attach embeds to the last chunk
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          const chunk = text.slice(i, i + MAX_LENGTH);
          if (i + MAX_LENGTH >= text.length) {
            await sendable.send({
              content: chunk === '' ? undefined : chunk,
              embeds: options?.embeds,
            });
          } else {
            await sendable.send({ content: chunk });
          }
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  private typingIntervals: Map<string, NodeJS.Timeout> = new Map();

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client) return;

    const channelId = jid.replace(/^dc:/, '');
    const currentInterval = this.typingIntervals.get(channelId);

    if (isTyping) {
      if (currentInterval) return; // already typing
      try {
        const channel = await this.client.channels.fetch(channelId);
        if (channel && 'sendTyping' in channel) {
          const sendable = channel as TextChannel | ThreadChannel;
          await sendable.sendTyping();
          const interval = setInterval(() => {
            sendable.sendTyping().catch(() => {});
          }, 9000); // refresh every 9s before Discord's 10s timeout
          this.typingIntervals.set(channelId, interval);
        }
      } catch (err) {
        logger.warn({ jid }, 'Failed to set typing status');
      }
    } else {
      if (currentInterval) {
        clearInterval(currentInterval);
        this.typingIntervals.delete(channelId);
      }
    }
  }

  async sendFile(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const sendable = channel as TextChannel | ThreadChannel;
      await sendable.send({
        content: caption,
        files: [filePath],
      });
      logger.info({ jid, filePath }, 'Discord file sent');
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to send Discord file');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      // Restore original https.globalAgent if we changed it for proxy
      if (this.originalHttpsAgent) {
        https.globalAgent = this.originalHttpsAgent;
        this.originalHttpsAgent = null;
      }
      logger.info('Discord bot stopped');
    }
  }

  async createChannel(
    fromJid: string,
    channelName: string,
  ): Promise<string | null> {
    if (!this.client) return null;
    try {
      const sourceChannelId = fromJid.replace(/^dc:/, '');
      const sourceChannel = await this.client.channels.fetch(sourceChannelId);
      if (
        !sourceChannel ||
        !('guild' in sourceChannel) ||
        !sourceChannel.guild
      ) {
        logger.warn(
          { fromJid },
          'Cannot create channel: source is not a guild channel',
        );
        return null;
      }

      const guild = sourceChannel.guild;
      const newChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
      });

      const newJid = `dc:${newChannel.id}`;
      logger.info({ fromJid, newJid, channelName }, 'Discord channel created');
      return newJid;
    } catch (err: any) {
      logger.error(
        { err: err.message, fromJid, channelName },
        'Failed to create Discord channel',
      );
      return null;
    }
  }

  async sendMessageReturningId(
    jid: string,
    text: string,
  ): Promise<string | null> {
    if (!this.client) return null;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) return null;
      const sendable = channel as TextChannel | ThreadChannel;
      const msg = await sendable.send({ content: text.slice(0, 2000) });
      return msg.id;
    } catch (err) {
      logger.error(
        { jid, err },
        'Failed to send Discord message (returning ID)',
      );
      return null;
    }
  }

  async editMessage(
    jid: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    if (!this.client) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return;
      const textChannel = channel as TextChannel | ThreadChannel;
      const msg = await textChannel.messages.fetch(messageId);
      await msg.edit({ content: text.slice(0, 2000) });
    } catch (err) {
      logger.error({ jid, messageId, err }, 'Failed to edit Discord message');
    }
  }

  async channelExists(jid: string): Promise<boolean> {
    if (!this.client) return false;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      return !!channel;
    } catch {
      return false;
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN', 'TC_DISCORD_TOKEN']);
  const token =
    process.env.TC_DISCORD_TOKEN ||
    process.env.DISCORD_BOT_TOKEN ||
    envVars.TC_DISCORD_TOKEN ||
    envVars.DISCORD_BOT_TOKEN ||
    '';

  if (!token) {
    logger.warn('Discord: TC_DISCORD_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts as DiscordChannelOpts);
});
