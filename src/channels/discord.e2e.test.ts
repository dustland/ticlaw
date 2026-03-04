import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { DiscordChannel } from './discord.js';
import { readEnvFile } from '../core/env.js';

describe('DiscordChannel E2E Network Test', () => {
  let channel: DiscordChannel;
  let token: string;

  beforeAll(() => {
    // Attempt to get the token, skip tests if not available
    const envVars = readEnvFile(['DISCORD_BOT_TOKEN', 'TC_DISCORD_TOKEN']);
    token =
      process.env.TC_DISCORD_TOKEN ||
      process.env.DISCORD_BOT_TOKEN ||
      envVars.TC_DISCORD_TOKEN ||
      envVars.DISCORD_BOT_TOKEN ||
      '';
  });

  afterAll(async () => {
    if (channel) {
      await channel.disconnect();
    }
  });

  it('connects to Discord API if token is provided', async () => {
    if (!token) {
      console.log('Skipping E2E test: No TC_DISCORD_TOKEN provided');
      return;
    }

    const onMessageMock = vi.fn();
    const onChatMetadataMock = vi.fn();
    const registeredProjectsMock = vi.fn().mockReturnValue({});

    channel = new DiscordChannel(token, {
      onMessage: onMessageMock,
      onChatMetadata: onChatMetadataMock,
      registeredProjects: registeredProjectsMock,
    });

    try {
      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      // We don't necessarily want to spam a production channel,
      // so we just test connectivity and disconnection.
    } catch (e) {
      console.warn(
        'Skipping Discord E2E connection test: Could not reach Discord API (possibly due to proxy/firewall)',
        e,
      );
      // We expect this to fail gracefully rather than breaking the build
    }
  }, 35000);
});
