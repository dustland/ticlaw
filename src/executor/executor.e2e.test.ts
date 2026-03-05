import { Executor } from './executor.js';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { describe, it } from 'vitest';

describe.skip('Executor E2E', () => {
  it('should run executor with real agent', async () => {
    // This is skipped by default as it requires an actual agent/CLI setup and network access
    process.env.http_proxy = 'http://127.0.0.1:7897';
    process.env.https_proxy = 'http://127.0.0.1:7897';

    const sessionId = `e2e-executor-${Date.now()}`;
    const testDir = path.join(os.tmpdir(), sessionId);
    fs.mkdirSync(testDir, { recursive: true });

    console.log('Creating Executor for session:', sessionId);
    console.log('Workspace Path:', testDir);

    let done = false;

    const executor = new Executor({
      group: {
        name: 'e2e-test-group',
        folder: sessionId,
        trigger: '* * * * *',
        added_at: new Date().toISOString(),
      },
      workspacePath: testDir,
      onOutput: async (output) => {
        if (output.result) {
          process.stdout.write(output.result + '\n');
        } else if (
          output.status === 'success' &&
          !output.result &&
          !output.newSessionId
        ) {
          console.log('\n[Executor Output Stream Completed]');
          done = true;
        }
      },
    });

    console.log('Dispatching prompt to agent...');
    const res = await executor.executePrompt(
      'say "hello world" and nothing else. Just output those words.',
    );
    console.log('Response:', res);

    // Wait for completion or timeout
    const start = Date.now();
    while (!done && Date.now() - start < 30000) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }, 35000);
});
