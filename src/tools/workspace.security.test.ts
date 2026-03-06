import { describe, expect, it, vi, beforeEach } from 'vitest';
import { buildWorkspaceTool } from './workspace.js';
import { spawnSync } from 'child_process';
import fs from 'fs';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
  execSync: vi.fn(),
}));

vi.mock('fs', async () => {
  return {
    default: {
      existsSync: vi.fn(),
      mkdirSync: vi.fn(),
      rmSync: vi.fn(),
    },
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

vi.mock('../core/config.js', () => ({
  TICLAW_HOME: '/tmp/ticlaw',
  ASSISTANT_NAME: 'ticlaw',
}));

describe('workspaceTool Security', () => {
  const sendFn = vi.fn();
  const createChannelFn = vi.fn();
  const registerProjectFn = vi.fn();
  const isChannelAliveFn = vi.fn();
  const registeredProjects = {};

  const tool = buildWorkspaceTool(
    'chat123',
    sendFn,
    createChannelFn,
    registerProjectFn,
    isChannelAliveFn,
    registeredProjects,
  );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should reject malicious repoFullName with special characters', async () => {
    const maliciousInputs = [
      'owner/repo; touch pwned',
      'owner/$(touch pwned)',
      'owner/repo&touch pwned',
      'owner/repo|touch pwned',
      'owner/repo\nsh -i',
      '../outside',
      'owner/repo ',
    ];

    for (const input of maliciousInputs) {
      vi.clearAllMocks();
      // Most of these will be caught by regex at the beginning
      // Some might be caught by split('/') length check if we didn't have regex
      await tool.execute({ operation: 'setup', repoFullName: input }, {} as any);

      const calls = sendFn.mock.calls.map(call => call[1]);
      const hasError = calls.some(msg =>
        msg.includes('Invalid repository name') ||
        msg.includes('Workspace operation failed for')
      );

      expect(hasError).toBe(true);
      expect(spawnSync).not.toHaveBeenCalled();
    }
  });

  it('should accept valid repoFullName', async () => {
    (fs.existsSync as any).mockReturnValue(false);
    await tool.execute({ operation: 'setup', repoFullName: 'owner/repo-name.test_123' }, {} as any);

    expect(spawnSync).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['clone', '--branch', 'main', '--single-branch', 'https://github.com/owner/repo-name.test_123.git', expect.any(String)]),
      expect.objectContaining({ timeout: 60000, encoding: 'utf-8' })
    );
  });

  it('should use spawnSync for git pull in update operation', async () => {
    (fs.existsSync as any).mockReturnValue(true);
    await tool.execute({ operation: 'update', repoFullName: 'owner/repo' }, {} as any);

    expect(spawnSync).toHaveBeenCalledWith(
      'git',
      ['pull'],
      expect.objectContaining({ cwd: expect.any(String) })
    );
  });
});
