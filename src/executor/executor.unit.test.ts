import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContainerOutput, RegisteredProject } from '../core/types.js';

type MockBridgeState = {
  hasSession: boolean;
  outputPath: string;
  createSessionCalls: string[];
  startTailingCalls: number;
  sendKeysCalls: string[];
  onData: ((data: string) => Promise<void> | void) | null;
};

const mockBridgeState: MockBridgeState = {
  hasSession: false,
  outputPath: path.join(os.tmpdir(), `executor-unit-${Date.now()}.log`),
  createSessionCalls: [],
  startTailingCalls: 0,
  sendKeysCalls: [],
  onData: null,
};

vi.mock('./tmux.js', () => {
  class MockTmuxBridge {
    outputPath: string;

    constructor(
      _sessionId: string,
      onData: (data: string) => Promise<void> | void,
    ) {
      this.outputPath = mockBridgeState.outputPath;
      mockBridgeState.onData = onData;
    }

    async hasSession(): Promise<boolean> {
      return mockBridgeState.hasSession;
    }

    async createSession(cwd: string): Promise<void> {
      mockBridgeState.createSessionCalls.push(cwd);
    }

    startTailing(): void {
      mockBridgeState.startTailingCalls += 1;
    }

    async sendKeys(keys: string): Promise<void> {
      mockBridgeState.sendKeysCalls.push(keys);
    }
  }

  return { TmuxBridge: MockTmuxBridge };
});

import { Executor } from './executor.js';

describe('Executor unit behavior', () => {
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
    mockBridgeState.startTailingCalls = 0;
    mockBridgeState.sendKeysCalls = [];
    mockBridgeState.onData = null;
  });

  it('starts tailing when reusing an existing session', async () => {
    mockBridgeState.hasSession = true;

    const executor = new Executor({
      group,
      workspacePath: workspaceDir,
      codingCli: 'echo',
    });

    await executor.executePrompt('hello');

    expect(mockBridgeState.createSessionCalls).toHaveLength(0);
    expect(mockBridgeState.startTailingCalls).toBe(1);
    expect(mockBridgeState.sendKeysCalls).toHaveLength(1);
  });

  it('parses JSON messages split across chunks without dropping output', async () => {
    const outputs: ContainerOutput[] = [];
    const executor = new Executor({
      group,
      workspacePath: workspaceDir,
      codingCli: 'echo',
      onOutput: async (output) => {
        outputs.push(output);
      },
    });

    await executor.executePrompt('hello');
    expect(mockBridgeState.onData).not.toBeNull();

    await mockBridgeState.onData!(
      '{"type":"init","session_id":"sess-1"}\n{"type":"message","role":"assistant","content":"hel',
    );
    await mockBridgeState.onData!('lo"}\nnot-json\n{"type":"result"}\n');

    expect(outputs).toEqual([
      { status: 'success', result: null, newSessionId: 'sess-1' },
      { status: 'success', result: 'hello' },
      { status: 'success', result: null },
    ]);
  });

  it('maps assistant content arrays and error events into container outputs', async () => {
    const outputs: ContainerOutput[] = [];
    const executor = new Executor({
      group,
      workspacePath: workspaceDir,
      codingCli: 'echo',
      onOutput: async (output) => {
        outputs.push(output);
      },
    });

    await executor.executePrompt('hello');
    expect(mockBridgeState.onData).not.toBeNull();

    await mockBridgeState.onData!(
      '{"type":"message","role":"assistant","content":[{"text":"A"},{"text":"B"}]}\n',
    );
    await mockBridgeState.onData!(
      '{"type":"error","error":{"message":"boom"}}\n{"type":"result","status":"error","error":"done-bad"}\n',
    );

    expect(outputs).toEqual([
      { status: 'success', result: 'AB' },
      { status: 'error', result: null, error: 'boom' },
      { status: 'error', result: null, error: 'done-bad' },
    ]);
  });

  it('generates a run script that mirrors output to tmux screen and output file', async () => {
    const executor = new Executor({
      group,
      workspacePath: workspaceDir,
      codingCli: 'echo',
    });

    await executor.executePrompt('hello');
    const sent = mockBridgeState.sendKeysCalls[0];
    expect(sent).toBeTruthy();

    const match = sent.match(/^bash '([^']+)'$/);
    expect(match).not.toBeNull();
    const runScriptPath = match![1];
    const script = fs.readFileSync(runScriptPath, 'utf8');

    expect(script).toContain('2>&1 | tee -a "$OUTPUT_FILE"');
    expect(script).toContain('CLI_EXIT_CODE=${PIPESTATUS[0]}');
    expect(script).toContain(
      '{"type":"error","error":"Agent CLI exited with code %s"}',
    );
  });
});
