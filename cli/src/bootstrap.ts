/**
 * `tc bootstrap` — First-time TiClaw setup.
 *
 * Steps:
 * 1. Detect platform and installed coding CLIs
 * 2. Collect configuration (data dir, proxy, API keys)
 * 3. Write ~/ticlaw/config.yaml
 * 4. Apply initial channel skill (Discord)
 * 5. Build the project
 * 6. Install and start system service
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import {
  prompt,
  PROJECT_ROOT,
  TICLAW_HOME,
  CONFIG_PATH,
} from './utils.js';

function detectCLIs(): Record<string, boolean> {
  const clis: Record<string, boolean> = {};
  for (const name of ['gemini', 'claude', 'codex', 'gh', 'git']) {
    try {
      execSync(`command -v ${name}`, { stdio: 'ignore' });
      clis[name] = true;
    } catch {
      clis[name] = false;
    }
  }
  return clis;
}

export async function bootstrap(): Promise<void> {
  console.log('\n🦀 TiClaw Bootstrap\n');

  // 1. Detect platform
  const platform = process.platform === 'darwin' ? 'macOS' : 'Linux';
  console.log(`  Platform: ${platform}`);

  // 2. Detect CLIs
  const clis = detectCLIs();
  console.log('  Detected CLIs:');
  for (const [name, found] of Object.entries(clis)) {
    console.log(`    ${found ? '✅' : '❌'} ${name}`);
  }

  const primaryCli = clis['gemini'] ? 'gemini' : clis['claude'] ? 'claude' : null;
  if (!primaryCli) {
    console.log(
      '\n  ⚠️  No coding CLI detected. Install Gemini CLI:',
      '\n     npm install -g @google/gemini-cli',
    );
  }
  console.log(`  Primary CLI: ${primaryCli || 'none (will need to install one)'}\n`);

  // 3. Collect configuration
  const dataDir = await prompt('Data directory', TICLAW_HOME);
  const httpProxy = await prompt('HTTP proxy (leave empty if not needed)', '');
  const githubRepo = await prompt('GitHub repo URL for first workspace', '');
  const discordToken = await prompt('Discord bot token (required for messaging)', '');
  const assistantName = await prompt('Assistant name', 'Andy');

  // Note: Gemini CLI and Claude use their own OAuth — no API key needed.
  // API keys are only needed for direct API access without a CLI.

  // LLM config (OpenRouter powers the agent brain)
  const openrouterKey = await prompt('OpenRouter API key (powers agent thinking)', '');
  const llmModel = await prompt('LLM model', 'google/gemini-2.5-flash');

  // 4. Build config object
  const config: any = {
    coding_cli: primaryCli || 'gemini',
    assistant_name: assistantName,
  };

  if (httpProxy) {
    config.proxy = httpProxy;
  }

  if (githubRepo) {
    config.default_repo = githubRepo;
  }

  // LLM
  if (openrouterKey) {
    config.llm = {
      api_key: openrouterKey,
      model: llmModel,
    };
  }

  // Channels
  const channels: any = {};
  if (discordToken) {
    channels.discord = { token: discordToken };
  }
  if (Object.keys(channels).length > 0) {
    config.channels = channels;
  }

  // 5. Write config.yaml
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });

  // Merge with existing config if present
  let existingConfig: any = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      existingConfig = yaml.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) || {};
      console.log('\n  Found existing config.yaml — merging...');
    } catch {
      // Ignore parse errors
    }
  }

  const mergedConfig = { ...existingConfig, ...config };
  if (config.channels) {
    mergedConfig.channels = { ...existingConfig.channels, ...config.channels };
  }
  if (config.api_keys) {
    mergedConfig.api_keys = { ...existingConfig.api_keys, ...config.api_keys };
  }

  fs.writeFileSync(CONFIG_PATH, yaml.stringify(mergedConfig));
  console.log(`\n  ✅ Configuration written to ${CONFIG_PATH}`);

  // 6. Apply Discord skill if token provided
  if (discordToken) {
    console.log('\n  📦 Applying Discord channel skill...');
    try {
      execSync('pnpm dlx tsx scripts/apply-skill.ts skills/add-discord', {
        cwd: PROJECT_ROOT,
        stdio: 'inherit',
      });
      console.log('  ✅ Discord channel installed');
    } catch {
      console.error('  ⚠️  Discord skill apply failed — you can retry with: tc skills add discord');
    }
  }

  // 7. Build
  console.log('\n  🔨 Building TiClaw...');
  try {
    execSync('pnpm run build', {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    });
    console.log('  ✅ Build complete');
  } catch {
    console.error('  ❌ Build failed. Run `pnpm run build` manually to see errors.');
    process.exit(1);
  }

  // 8. Install and start service
  console.log('\n  🚀 Installing system service...');
  try {
    execSync('pnpm dlx tsx setup/index.ts --step service', {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    });
    console.log('  ✅ Service installed and started');
  } catch {
    console.error('  ⚠️  Service install failed. You can start manually with: tc start');
  }

  // Done
  console.log('\n  🦀 TiClaw is ready!');
  console.log(`  Config: ${CONFIG_PATH}`);
  console.log(`  Data: ${dataDir}`);
  console.log(`  Primary CLI: ${primaryCli || 'gemini'}`);
  if (discordToken) console.log('  Discord: enabled');
  console.log('\n  Next steps:');
  console.log('    • Send a message in your Discord channel to test');
  console.log('    • Run `tc status` to verify service is running');
  console.log('    • Run `tc skills list` to see available skills\n');
}
