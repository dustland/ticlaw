import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { TmuxBridge } from './tmux.js';
import fs from 'fs';
import { execSync } from 'child_process';

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

  it('tails only newly appended lines for an existing output file', async () => {
    const staleMessage = `stale-${Date.now()}`;
    fs.writeFileSync(bridge.outputPath, `${staleMessage}\n`);

    bridge.startTailing();
    await new Promise((r) => setTimeout(r, 700));

    const initialRead = receivedData.join('\n');
    expect(initialRead).not.toContain(staleMessage);

    const freshMessage = `fresh-${Date.now()}`;
    fs.appendFileSync(bridge.outputPath, `${freshMessage}\n`);

    const startedAt = Date.now();
    while (Date.now() - startedAt < 3000) {
      if (receivedData.join('\n').includes(freshMessage)) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const finalRead = receivedData.join('\n');
    expect(finalRead).toContain(freshMessage);
  });

  it('can mirror live output to both tmux screen and IPC tail stream', async () => {
    await bridge.createSession(testDir);
    bridge.startTailing();
    await new Promise((r) => setTimeout(r, 700));

    const marker = `screen-and-ipc-${Date.now()}`;
    await bridge.sendKeys(
      `echo "${marker}" 2>&1 | tee -a ${bridge.outputPath}`,
    );

    const startedAt = Date.now();
    while (Date.now() - startedAt < 3000) {
      if (receivedData.join('\n').includes(marker)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(receivedData.join('\n')).toContain(marker);

    const paneText = execSync(`tmux capture-pane -pt tc-${sessionId}`)
      .toString()
      .trim();
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(paneText).toMatch(new RegExp(`^\\s*${escaped}\\s*$`, 'm'));
  });
});
