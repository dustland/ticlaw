import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { TmuxBridge } from './tmux.js';
import fs from 'fs';
import path from 'path';

describe('TmuxBridge Feature', () => {
  const sessionId = `test-bridge-${Date.now()}`;
  let bridge: TmuxBridge;
  let receivedData: string[] = [];
  const testDir = process.cwd();

  beforeEach(() => {
    receivedData = [];
    bridge = new TmuxBridge(sessionId, (data) => {
      receivedData.push(data.trim());
    });
  });

  afterEach(async () => {
    // Clean up real tmux session
    try {
      await bridge.killSession();
    } catch {
      // ignore
    }
  });

  it('spawns a real tmux session, tails output, and captures sendKeys', async () => {
    // 1. Create the session
    await bridge.createSession(testDir);
    expect(await bridge.hasSession()).toBe(true);

    bridge.startTailing();

    // 2. Wait a moment for bash to initialize and tail to start
    await new Promise((r) => setTimeout(r, 1000));

    // 3. Send a command that redirects output to bridge.outputPath
    const testMessage = `hello-from-tmux-${Date.now()}`;
    await bridge.sendKeys(`echo "${testMessage}" >> ${bridge.outputPath} 2>&1`);

    // 4. Wait for the tail to pick it up
    await new Promise((r) => setTimeout(r, 2000));

    // 5. Verify the data was received by the onData callback
    const fullReceived = receivedData.join('\n');
    expect(fullReceived).toContain(testMessage);

    // 6. Test killSession works
    await bridge.killSession();
    expect(await bridge.hasSession()).toBe(false);

    // Output file should be deleted by killSession
    expect(fs.existsSync(bridge.outputPath)).toBe(false);
  });
});
