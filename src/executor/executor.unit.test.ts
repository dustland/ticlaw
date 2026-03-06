import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RegisteredProject } from '../core/types.js';

const mockBridgeState = {
  hasSession: false,
  createSessionCalls: [] as string[],
  sendPromptCalls: [] as string[],
  paneText: 'idle screen',
};

vi.mock('./tmux.js', () => {
  class MockTmuxBridge {
    session = 'tc-mock';
    constructor(_sessionId: string) {}
    async hasSession() {
      return mockBridgeState.hasSession;
    }
    async createSession(cwd: string) {
      mockBridgeState.createSessionCalls.push(cwd);
      mockBridgeState.hasSession = true;
    }
    async capturePaneText() {
      return mockBridgeState.paneText;
    }
    async sendRawKeys() {}
    async sendPrompt(text: string) {
      mockBridgeState.sendPromptCalls.push(text);
    }
    async launchGemini() {
      mockBridgeState.hasSession = true;
    }
    async killSession() {
      mockBridgeState.hasSession = false;
    }
  }
  return { TmuxBridge: MockTmuxBridge };
});

import { Executor } from './executor.js';

describe('Executor', () => {
  const workspaceDir = path.join(os.tmpdir(), `executor-unit-${process.pid}`);
  const group: RegisteredProject = {
    name: 'unit-group',
    folder: 'unit-folder',
    trigger: '* * * * *',
    added_at: new Date().toISOString(),
  };

  beforeEach(() => {
    fs.mkdirSync(workspaceDir, { recursive: true });
    mockBridgeState.hasSession = false;
    mockBridgeState.createSessionCalls = [];
    mockBridgeState.sendPromptCalls = [];
    mockBridgeState.paneText = 'idle screen';
  });

  it('capture() creates session if needed and returns raw pane text', async () => {
    const executor = new Executor({ group, workspacePath: workspaceDir });
    const screen = await executor.capture();
    expect(mockBridgeState.createSessionCalls).toHaveLength(1);
    expect(screen).toBe('idle screen');
  });

  it('capture() reuses existing session', async () => {
    mockBridgeState.hasSession = true;
    const executor = new Executor({ group, workspacePath: workspaceDir });
    const screen = await executor.capture();
    expect(mockBridgeState.createSessionCalls).toHaveLength(0);
    expect(screen).toBe('idle screen');
  });

  it('send() creates session if needed and sends text', async () => {
    const executor = new Executor({ group, workspacePath: workspaceDir });
    await executor.send('hello');
    expect(mockBridgeState.createSessionCalls).toHaveLength(1);
    expect(mockBridgeState.sendPromptCalls).toContain('hello');
  });
});
