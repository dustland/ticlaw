import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAgentOrchestrator } from '../agent.js';
import * as ai from 'ai';

// Mock the AI SDK and dependencies
vi.mock('ai', () => ({
  generateText: vi.fn(),
  tool: vi.fn((x) => x),
}));

vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: vi.fn().mockReturnValue(() => 'mock-model'),
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn().mockReturnValue({ OPENROUTER_API_KEY: 'test-key' }),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock the tools
vi.mock('../tools/executor.js', () => ({
  buildExecutorTool: vi.fn().mockReturnValue({
    execute: vi.fn().mockResolvedValue('Executor called'),
  }),
}));

vi.mock('../tools/setup-workspace.js', () => ({
  buildSetupWorkspaceTool: vi.fn().mockReturnValue({
    execute: vi.fn().mockResolvedValue('Setup called'),
  }),
}));

describe('Agent Orchestrator', () => {
  const dummyOpts = {
    chatJid: 'test-jid',
    group: {
      name: 'tiwater/ticos',
      folder: 'tiwater-ticos',
      trigger: '@TC',
      added_at: new Date().toISOString(),
      isMain: false,
    },
    workspacePath: '/tmp/workspace',
    isMain: false,
    messages: [{ role: 'user' as const, content: 'test message' }],
    sendFn: vi.fn(),
    createChannelFn: vi.fn(),
    registerProjectFn: vi.fn(),
    isChannelAliveFn: vi.fn(),
    registeredProjects: {},
    onReply: vi.fn(),
    onOutput: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call generateText with correct model and tools', async () => {
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      text: 'I have scheduled the requested work via tools.',
      toolCalls: [],
    } as any);

    const result = await runAgentOrchestrator(dummyOpts);

    expect(ai.generateText).toHaveBeenCalled();
    const callArgs = vi.mocked(ai.generateText).mock.calls[0][0];

    expect((callArgs as any).system).toContain('You are TiClaw');
    expect((callArgs as any).tools).toHaveProperty('executorTool');
    expect((callArgs as any).tools).toHaveProperty('workspaceTool');

    expect(result).toBe('I have scheduled the requested work via tools.');
    expect(dummyOpts.onReply).toHaveBeenCalledWith(
      'I have scheduled the requested work via tools.',
    );
  });
});
