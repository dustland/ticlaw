import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DiscordChannel } from './discord.js';
import * as discordJs from 'discord.js';

vi.mock('discord.js', async () => {
  const actual = await vi.importActual<any>('discord.js');

  const mockClientInstance = {
    on: vi.fn(),
    once: vi.fn(function (this: any, event, cb) {
      // Immediately trigger the ready callback with the client itself as argument
      if (typeof cb === 'function') cb(this);
    }),
    login: vi.fn().mockResolvedValue('token'),
    channels: {
      fetch: vi.fn(),
    },
    guilds: {
      cache: {
        first: vi.fn().mockReturnValue({
          channels: {
            create: vi.fn(),
          },
        }),
      },
    },
    destroy: vi.fn(),
    user: { id: 'bot-123' },
    isReady: () => true,
  };

  class MockClientConstructor {
    constructor() {
      return mockClientInstance;
    }
  }

  return {
    ...actual,
    Client: MockClientConstructor,
    __mockClientInstance: mockClientInstance, // Expose for tests
  };
});

describe('DiscordChannel Integration/Adapter', () => {
  let channel: DiscordChannel;
  let onMessageMock: ReturnType<typeof vi.fn>;
  let onChatMetadataMock: ReturnType<typeof vi.fn>;
  let registeredProjectsMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    onMessageMock = vi.fn();
    onChatMetadataMock = vi.fn();
    registeredProjectsMock = vi.fn().mockReturnValue({
      'test-group': { name: 'test-group', folder: 'test-folder' },
      'dc:thread-789': { name: 'test-thread', folder: 'test-folder' },
    });

    channel = new DiscordChannel('dummy-token', {
      onMessage: onMessageMock as any,
      onChatMetadata: onChatMetadataMock as any,
      registeredProjects: registeredProjectsMock as any,
    });
  });

  it('can connect and register event listeners', async () => {
    await channel.connect();
    expect(channel.isConnected()).toBe(true);

    const clientInstance = (discordJs as any).__mockClientInstance;
    expect(clientInstance.login).toHaveBeenCalledWith('dummy-token');
    expect(clientInstance.on).toHaveBeenCalledWith(
      discordJs.Events.MessageCreate,
      expect.any(Function),
    );
  });

  it('verifies jid ownership correctly', async () => {
    await channel.connect();
    // Discord channel considers a jid "owned" if it starts with discord:
    expect(channel.ownsJid('dc:1234567')).toBe(true);
    expect(channel.ownsJid('slack:1234567')).toBe(false);
  });

  it('disconnects by destroying client', async () => {
    await channel.connect();
    const clientInstance = (discordJs as any).__mockClientInstance;
    await channel.disconnect();
    expect(clientInstance.destroy).toHaveBeenCalled();
  });

  describe('Message Parsing (Simulated)', () => {
    let messageHandler: (msg: any) => Promise<void>;
    let clientInstance: any;

    beforeEach(async () => {
      await channel.connect();
      clientInstance = (discordJs as any).__mockClientInstance;
      const onCall = clientInstance.on.mock.calls.find(
        (c: any) => c[0] === discordJs.Events.MessageCreate,
      );
      messageHandler = onCall![1];
    });

    it('ignores messages from itself', async () => {
      await messageHandler({
        author: { id: 'bot-123' },
        createdAt: new Date(),
        content: '',
        mentions: { users: { has: vi.fn() } },
        attachments: { size: 0 },
      });
      expect(onMessageMock).not.toHaveBeenCalled();
    });

    it('parses a text message from a known thread', async () => {
      const mockMsg = {
        id: 'msg-1',
        channelId: 'thread-789',
        author: { id: 'user-456', username: 'test-user' },
        channel: {
          id: 'thread-789',
          isThread: () => true,
          name: 'test-group',
        },
        content: 'hello bot',
        createdAt: new Date('2026-03-04T12:00:00Z'),
        mentions: { users: { has: vi.fn() } },
        attachments: { size: 0 },
        reply: vi.fn(),
      };

      await messageHandler(mockMsg);

      expect(onMessageMock).toHaveBeenCalledWith('dc:thread-789', {
        id: 'msg-1',
        chat_jid: 'dc:thread-789',
        sender: 'user-456',
        sender_name: 'test-user',
        content: 'hello bot',
        timestamp: '2026-03-04T12:00:00.000Z',
        is_from_me: false,
      });
    });

    it('auto-registers a group if message mentions bot', async () => {
      const mockMsg = {
        id: 'msg-2',
        channelId: 'channel-000',
        author: { id: 'user-456', username: 'test-user' },
        mentions: { users: { has: vi.fn().mockReturnValue(true) } },
        channel: {
          id: 'channel-000',
          isThread: () => false,
          threads: {
            create: vi.fn().mockResolvedValue({
              id: 'new-thread-111',
              name: 'user-456-12345',
            }),
          },
        },
        content: '<@bot-123> help me',
        createdAt: new Date('2026-03-04T12:00:00Z'),
        attachments: { size: 0 },
        reply: vi.fn(),
      };

      await messageHandler(mockMsg);

      expect(onMessageMock).toHaveBeenCalledWith('dc:channel-000', {
        id: 'msg-2',
        chat_jid: 'dc:channel-000',
        sender: 'user-456',
        sender_name: 'test-user',
        content: '@Shaw help me', // Assuming ASSISTANT_NAME is 'Shaw' in tests
        timestamp: '2026-03-04T12:00:00.000Z',
        is_from_me: false,
      });
    });
  });
});
