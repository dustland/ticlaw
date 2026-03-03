import { AcWorkspace } from '../src/executor/workspace.js';
import { logger } from '../src/logger.js';
import fs from 'fs';
import path from 'path';

async function testPincerFlow() {
  const testId = 'test-ticos-task-' + Date.now();
  const repoUrl = 'https://github.com/tiwater/ticos.git';
  
  logger.info({ testId, repoUrl }, '🧪 Starting local Pincer integration test');

  const workspace = new AcWorkspace({
    id: testId,
    name: 'Ticos Local Test',
    githubUrl: repoUrl
  });

  try {
    // 1. Initialize directory
    await workspace.init();
    logger.info('✅ Workspace directory initialized');

    // 2. Run Auto-Bootstrap (Clone + Seed + Install)
    logger.info('⏳ Starting auto-bootstrap (this may take a minute due to pnpm install)...');
    const result = await workspace.autoBootstrap();

    if (result.success) {
      logger.info('✅ Auto-bootstrap completed successfully');
      
      // 3. Verification
      const webEnv = path.join(workspace.rootDir, 'packages', 'web', '.env');
      const opsEnv = path.join(workspace.rootDir, 'packages', 'ops', '.env');
      const nodeModules = path.join(workspace.rootDir, 'node_modules');

      const webEnvExists = fs.existsSync(webEnv);
      const opsEnvExists = fs.existsSync(opsEnv);
      const modulesExist = fs.existsSync(nodeModules);

      console.log('\n--- Test Results ---');
      console.log(`Workspace: ${workspace.rootDir}`);
      console.log(`Web .env Seeded:  ${webEnvExists ? '✅' : '❌'}`);
      console.log(`Ops .env Seeded:  ${opsEnvExists ? '✅' : '❌'}`);
      console.log(`Deps Installed:   ${modulesExist ? '✅' : '❌'}`);
      console.log('--------------------\n');

      if (webEnvExists && opsEnvExists && modulesExist) {
        logger.info('🚀 Pincer workflow verified! The environment is perfectly prepared.');
      } else {
        logger.error('❌ Verification failed. Some components are missing.');
      }
    } else {
      logger.error({ log: result.log }, '❌ Auto-bootstrap failed');
    }
  } catch (err) {
    logger.error({ err }, '💥 Test crashed');
  } finally {
    await workspace.stop();
  }
}

testPincerFlow();
