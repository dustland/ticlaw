import { Executor } from './executor.js';
import path from 'path';
import os from 'os';
import fs from 'fs';

async function test() {
  process.env.http_proxy = 'http://127.0.0.1:7897';
  process.env.https_proxy = 'http://127.0.0.1:7897';

  const sessionId = `e2e-executor-${Date.now()}`;
  const testDir = path.join(os.tmpdir(), sessionId);
  fs.mkdirSync(testDir, { recursive: true });

  console.log('Creating Executor for session:', sessionId);
  console.log('Workspace Path:', testDir);

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
        setTimeout(() => {
          process.exit(0);
        }, 1000);
      }
    },
  });

  console.log('Dispatching prompt to agent...');
  const res = await executor.executePrompt(
    'say "hello world" and nothing else. Just output those words.',
  );
  console.log('Response:', res);

  // Set a hard timeout so it doesn't hang forever
  setTimeout(() => {
    console.error('Test timed out after 30 seconds');
    process.exit(1);
  }, 30000);
}

test().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
