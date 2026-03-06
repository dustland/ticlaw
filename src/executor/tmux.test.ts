import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { TmuxBridge } from './tmux.js';

describe('TmuxBridge Feature', () => {
  const sessionId = `test-bridge-${Date.now()}`;
  let bridge: TmuxBridge;
  const testDir = process.cwd();

  beforeEach(() => {
    bridge = new TmuxBridge(sessionId);
  });

  afterEach(async () => {
    try {
      await bridge.killSession();
    } catch {
      // ignore
    }
  });

  it('creates a tmux session and verifies it exists', async () => {
    // Manually create a basic session for testing (not launching gemini)
    const { execSync } = await import('child_process');
    execSync(`tmux new-session -d -s tc-${sessionId} -c ${testDir}`);

    expect(await bridge.hasSession()).toBe(true);

    await bridge.killSession();
    expect(await bridge.hasSession()).toBe(false);
  });

  it('captures pane text via capturePaneText', async () => {
    const { execSync } = await import('child_process');
    // Kill any leftover from previous test
    try {
      execSync(`tmux kill-session -t tc-${sessionId} 2>/dev/null`);
    } catch {}
    execSync(`tmux new-session -d -s tc-${sessionId} -c ${testDir}`);

    // Send a command to the shell
    await bridge.sendRawKeys('echo hello-capture-test');
    await bridge.sendRawKeys('Enter');

    await new Promise((r) => setTimeout(r, 1000));

    const paneText = await bridge.capturePaneText();
    expect(paneText).toContain('hello-capture-test');
  });

  it('sendPrompt sends text followed by Enter', async () => {
    const { execSync } = await import('child_process');
    execSync(`tmux new-session -d -s tc-${sessionId} -c ${testDir}`);

    await bridge.sendPrompt('echo prompt-test-marker');

    await new Promise((r) => setTimeout(r, 1000));

    const paneText = await bridge.capturePaneText();
    expect(paneText).toContain('prompt-test-marker');
  });
});
