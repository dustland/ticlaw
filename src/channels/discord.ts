import {
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

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { AcWorkspace } from '../executor/workspace.js';

export interface DiscordChannelOpts extends ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onGroupRegistered?: (jid: string, group: RegisteredGroup) => void;
  onVerify?: (chatJid: string, url: string) => Promise<void>;
  onPush?: (chatJid: string) => Promise<void>;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;

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

      // Agent for REST (undici)
      clientOptions.rest = {
        agent: new ProxyAgent(proxyUrl),
      };

      // Agent for Gateway (WebSocket)
      clientOptions.ws = {
        agent: new HttpsProxyAgent(proxyUrl),
      };
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

      // Special Command: /pincer
      if (content.startsWith('/pincer')) {
        await this.handlePincerCommand(message);
        return;
      }

      // Special Command: /verify
      if (content.startsWith('/verify')) {
        const parts = content.split(' ');
        const url = parts[1];
        if (url && this.opts.onVerify) {
          await message.reply(
            `🦀 Initializing Playwright verification for ${url}...`,
          );
          await this.opts.onVerify(chatJid, url);
        } else {
          await message.reply('Usage: `/verify https://your-app-url.com`');
        }
        return;
      }

      // Special Command: /push
      if (content.startsWith('/push')) {
        if (this.opts.onPush) {
          await this.opts.onPush(chatJid);
        }
        return;
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

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
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
        { chatJid, chatName, sender: senderName },
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

  private async handlePincerCommand(message: Message): Promise<void> {
    const parts = message.content.split(' ');
    const url = parts[1];

    if (!url) {
      await message.reply(
        'Please provide a GitHub Issue URL. Usage: `/pincer https://github.com/user/repo/issues/1`',
      );
      return;
    }

    try {
      // 1. Create a Discord Thread
      const threadName = `🦀-pincer-${message.author.username}-${Date.now().toString().slice(-4)}`;
      let thread: AnyThreadChannel;

      if (message.channel instanceof TextChannel) {
        thread = await message.channel.threads.create({
          name: threadName,
          autoArchiveDuration: 60,
          reason: `AquaClaw Pincer task for ${url}`,
        });
      } else {
        await message.reply('Pincer command must be run in a text channel.');
        return;
      }

      const threadJid = `dc:${thread.id}`;
      await thread.send(
        `雪蟹已就位 (AquaClaw ready). Target: ${url}\nInitializing physical workspace...`,
      );

      // 2. Initialize Workspace
      const workspace = new AcWorkspace({
        id: thread.id,
        name: threadName,
        githubUrl: url,
        onFileAdded: async (filePath) => {
          await this.sendFile(threadJid, filePath, '📸 New Snapshot');
        },
        onSummary: async (summary) => {
          await this.sendMessage(threadJid, `📝 **Delta Feed:** ${summary}`);
        },
      });
      await workspace.init();

      // 3. Register Group Automatically
      const newGroup: RegisteredGroup = {
        name: threadName,
        folder: thread.id, // Using thread ID as folder name for uniqueness
        trigger: `@${ASSISTANT_NAME}`,
        added_at: new Date().toISOString(),
        requiresTrigger: false, // Threads created by /pincer are auto-commanded
        isMain: false,
      };

      if (this.opts.onGroupRegistered) {
        this.opts.onGroupRegistered(threadJid, newGroup);
      }

      await thread.send(
        `Workspace initialized at \`~/aquaclaw/factory/${thread.id}\`. I am now listening to this thread.`,
      );

      // Send the initial prompt to the agent
      this.opts.onMessage(threadJid, {
        id: `init-${Date.now()}`,
        chat_jid: threadJid,
        sender: message.author.id,
        sender_name: message.author.username,
        content: `@${ASSISTANT_NAME} Please start working on this issue: ${url}. The workspace is already initialized.`,
        timestamp: new Date().toISOString(),
        is_from_me: false,
      });
    } catch (err: any) {
      logger.error({ err: err.message }, 'Failed to handle /pincer command');
      await message.reply(`Failed to start Pincer task: ${err.message}`);
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
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

      // Check if it's a ThreadChannel or TextChannel
      const sendable = channel as TextChannel | ThreadChannel;

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await sendable.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendable.send(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  async sendFile(jid: string, filePath: string, caption?: string): Promise<void> {
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
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as any).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN', 'AC_DISCORD_TOKEN']);
  const token =
    process.env.AC_DISCORD_TOKEN ||
    process.env.DISCORD_BOT_TOKEN ||
    envVars.AC_DISCORD_TOKEN ||
    envVars.DISCORD_BOT_TOKEN ||
    '';

  if (!token) {
    logger.warn('Discord: AC_DISCORD_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts as DiscordChannelOpts);
});
