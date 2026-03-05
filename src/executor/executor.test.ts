import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Executor } from './executor.js';
import { RegisteredProject, ContainerOutput } from '../core/types.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

describe('Executor Feature', () => {
  const sessionId = `tc-executor-test-${Date.now()}`;
  const testDir = path.join(os.tmpdir(), sessionId);
  const dummyCliPath = path.join(testDir, 'dummy-cli.js');
  const group: RegisteredProject = {
    name: 'test-group',
    folder: sessionId, // This is used as the tmux session ID!
    trigger: '* * * * *',
    added_at: new Date().toISOString(),
  };

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });

    // Create a dummy node script that acts like a coding CLI
    // It should read the prompt file and output streaming json.
    const dummyCliCode = `
      const fs = require('fs');
      
      // The prompt is passed as -p with the resolved prompt text from the shell
      const args = process.argv.slice(2);
      const promptArgIndex = args.indexOf('-p');
      let promptText = 'default';
      
      if (promptArgIndex !== -1 && args[promptArgIndex + 1]) {
        const rawArg = args[promptArgIndex + 1];
        promptText = rawArg;
      }

      console.log(JSON.stringify({ type: 'init', session_id: 'dummy-session-123' }));
      setTimeout(() => {
        console.log(JSON.stringify({ type: 'message', role: 'assistant', content: 'Received: ' + promptText.trim() }));
      }, 500);
      setTimeout(() => {
        console.log(JSON.stringify({ type: 'result' }));
        process.exit(0);
      }, 1000);
    `;
    fs.writeFileSync(dummyCliPath, dummyCliCode);
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('executes a prompt and parses the streaming JSON output', async () => {
    const outputs: ContainerOutput[] = [];

    const executor = new Executor({
      group,
      workspacePath: testDir,
      codingCli: `node ${dummyCliPath}`,
      onOutput: async (output) => {
        outputs.push(output);
      },
    });

    // Give tmux a second to properly spawn and set up tailing before dispatching the prompt.
    // In a real scenario, the session survives between prompts, but here we spawn it fresh.
    const result = await executor.executePrompt('hello executor');
    expect(result).toBe('Dispatched instruction to the workspace agent.');

    // Wait for the tmux bridge to process the script's output
    // The script takes ~1.5 seconds to finish, and tail needs time to catch it
    const startWait = Date.now();
    while (outputs.length < 3 && Date.now() - startWait < 5000) {
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(outputs.length).toBeGreaterThanOrEqual(3);

    // Verify parsed events
    expect(outputs[0]).toEqual({
      status: 'success',
      result: null,
      newSessionId: 'dummy-session-123',
    });

    expect(outputs[1]).toEqual({
      status: 'success',
      result: 'Received: hello executor',
    });

    expect(outputs[2]).toEqual({
      status: 'success',
      result: null,
    });
  }, 10000);
});
