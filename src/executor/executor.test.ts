import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import type { RegisteredProject } from '../core/types.js';
import { Executor } from './executor.js';
import { TmuxBridge } from './tmux.js';

const sessionId = `tc-executor-test-${Date.now()}`;

describe('Executor integration', () => {
  const testDir = path.join(os.tmpdir(), `executor-test-${Date.now()}`);
  const group: RegisteredProject = {
    name: 'test-group',
    folder: `executor-test-${Date.now()}`,
    trigger: '* * * * *',
    added_at: new Date().toISOString(),
  };

  afterAll(async () => {
    try {
      const bridge = new TmuxBridge(group.folder);
      await bridge.killSession();
    } catch {}
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('creates a tmux session and sends prompt via sendPrompt', async () => {
    const executor = new Executor({
      group,
      workspacePath: testDir,
      codingCli: 'bash',
    });

    // capture() should create the session
    const screen = await executor.capture();
    expect(typeof screen).toBe('string');

    // send() should send text
    await executor.send('echo hello');

    // capture() again should show the result
    // (give bash a moment to process)
    await new Promise((r) => setTimeout(r, 500));
    const afterScreen = await executor.capture();
    expect(afterScreen).toContain('hello');
  });
});
