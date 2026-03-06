/**
 * E2E test: calls runAgentOrchestrator directly, bypassing Discord.
 * Tests the full event-driven flow:
 *   agent → send prompt → immediate acknowledgment
 *   background monitor → idle detected → interpretScreen → async delivery
 *
 * Usage: npx tsx src/executor/executor.e2e.ts
 */
import { runAgentOrchestrator } from '../agent.js';

async function test() {
  // Proxy for Gemini CLI
  process.env.http_proxy = process.env.http_proxy || 'http://127.0.0.1:7897';
  process.env.https_proxy = process.env.https_proxy || 'http://127.0.0.1:7897';

  const group = {
    name: 'tiwater/ticos',
    folder: 'tiwater-ticos',
    trigger: '@Shaw',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    isMain: false,
  };

  const workspacePath = '/Users/hugh/ticlaw/factory/tiwater-ticos';

  console.log(
    '\n=== E2E Test: Event-Driven Gemini via Agent Orchestrator ===\n',
  );
  console.log('Group:', group.name);
  console.log('Workspace:', workspacePath);
  console.log('');

  // Track both the sync acknowledgment and async callback delivery
  let asyncReplyCount = 0;
  const asyncDone = new Promise<void>((resolve) => {
    var checkReply = (text: string) => {
      asyncReplyCount++;
      if (asyncReplyCount === 1) {
        console.log('📩 Agent immediate reply:\n');
        console.log(text);
        console.log('');
        console.log('⏳ Waiting for async callback delivery...\n');
      } else {
        console.log('📩 Async callback delivery:\n');
        console.log(text);
        console.log('');
        resolve();
      }
    };

    // --- Test 1: Simple repo question ---
    console.log('--- Test 1: "what was the last commit?" ---\n');

    runAgentOrchestrator({
      chatJid: 'e2e-test',
      group,
      workspacePath,
      isMain: false,
      messages: [{ role: 'user', content: '@Shaw what was the last commit?' }],
      sendFn: async (_jid, _text) => {},
      createChannelFn: async () => null,
      registerProjectFn: () => {},
      isChannelAliveFn: async () => true,
      registeredProjects: {},
      onReply: async (text) => {
        checkReply(text);
      },
    }).then((result) => {
      console.log('--- Agent returned ---');
      console.log('Sync result:', result.slice(0, 200));
      console.log('');
    });
  });

  // Wait for the async callback (max 3 minutes)
  const timeout = setTimeout(() => {
    console.error('⚠️ Timeout: async callback did not fire within 3 minutes');
    process.exit(1);
  }, 180_000);

  await asyncDone;
  clearTimeout(timeout);

  console.log(
    '\n=== E2E Test Complete: Both sync and async delivery verified ===\n',
  );
  process.exit(0);
}

test().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
