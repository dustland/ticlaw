/**
 * `tc env` — Manage TiClaw environments.
 *
 * Subcommands:
 *   tc env add <name>       Create environment (repo + Discord channel + workspace)
 *   tc env list             List all environments
 *   tc env remove <name>    Remove an environment
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import type { Command } from 'commander';
import {
  prompt,
  readConfig,
  TICLAW_HOME,
  CONFIG_PATH,
} from './utils.js';

const WORKSPACES_DIR = path.join(TICLAW_HOME, 'workspaces');
const ENVS_DIR = path.join(TICLAW_HOME, 'envs');
const STORE_DIR = path.join(TICLAW_HOME, 'store');
const GROUPS_DIR = path.join(TICLAW_HOME, 'groups');

function ghAvailable(): boolean {
  try {
    execSync('command -v gh', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

interface RepoInfo {
  nameWithOwner: string;
  description: string;
}

function searchRepos(query: string): RepoInfo[] {
  try {
    const output = execSync(
      `gh repo list --json nameWithOwner,description --limit 30 2>/dev/null`,
      { encoding: 'utf-8' },
    );
    const repos: RepoInfo[] = JSON.parse(output);
    if (!query) return repos;
    const q = query.toLowerCase();
    return repos.filter(
      (r) =>
        r.nameWithOwner.toLowerCase().includes(q) ||
        (r.description && r.description.toLowerCase().includes(q)),
    );
  } catch {
    return [];
  }
}

function readEnvConfig(name: string): any {
  const configPath = path.join(ENVS_DIR, name, 'config.yaml');
  try {
    return yaml.parse(fs.readFileSync(configPath, 'utf-8')) || {};
  } catch {
    return {};
  }
}

function getDiscordToken(): string | null {
  const config = readConfig();
  return (
    config.channels?.discord?.token ||
    process.env.TC_DISCORD_TOKEN ||
    process.env.DISCORD_BOT_TOKEN ||
    null
  );
}

// --- Add Environment ---

async function addEnv(name: string): Promise<void> {
  console.log(`\n  🦀 Creating environment: ${name}\n`);

  // 1. Select repo via gh
  let repoFullName = '';
  if (ghAvailable()) {
    console.log('  Searching your GitHub repositories...');
    const repos = searchRepos(name);

    if (repos.length > 0) {
      console.log('\n  Matching repos:');
      repos.forEach((r, i) => {
        const desc = r.description ? ` — ${r.description.slice(0, 50)}` : '';
        console.log(`    ${i + 1}. ${r.nameWithOwner}${desc}`);
      });

      const choice = await prompt(
        '\n  Select repo number (or type full repo name)',
        '1',
      );

      const num = parseInt(choice, 10);
      if (num > 0 && num <= repos.length) {
        repoFullName = repos[num - 1].nameWithOwner;
      } else {
        repoFullName = choice;
      }
    } else {
      repoFullName = await prompt('  GitHub repo (owner/name)');
    }
  } else {
    repoFullName = await prompt('  GitHub repo (owner/name)');
  }

  if (!repoFullName || !repoFullName.includes('/')) {
    console.error('  ❌ Invalid repo format. Expected: owner/repo');
    process.exit(1);
  }

  const branch = await prompt('  Branch', 'main');

  // 2. Clone workspace
  const [owner, repo] = repoFullName.split('/');
  const workspaceDir = path.join(WORKSPACES_DIR, owner, repo, branch);

  if (fs.existsSync(workspaceDir)) {
    console.log(`  ℹ️  Workspace already exists: ${workspaceDir}`);
  } else {
    console.log(`\n  📦 Cloning ${repoFullName}@${branch}...`);
    fs.mkdirSync(path.dirname(workspaceDir), { recursive: true });
    try {
      execSync(
        `git clone --branch ${branch} --single-branch https://github.com/${repoFullName}.git ${workspaceDir}`,
        { stdio: 'inherit' },
      );
      console.log('  ✅ Cloned successfully');
    } catch {
      console.error('  ❌ Clone failed');
      process.exit(1);
    }
  }

  // 3. Create Discord channel
  let discordChannelId = '';
  const discordToken = getDiscordToken();

  if (discordToken) {
    console.log(`\n  💬 Creating Discord channel #${name}...`);
    try {
      // Use Discord REST API directly to avoid importing full discord.js
      const response = await fetch('https://discord.com/api/v10/users/@me/guilds', {
        headers: { Authorization: `Bot ${discordToken}` },
      });
      const guilds = await response.json() as any[];

      if (guilds.length === 0) {
        console.log('  ⚠️  Bot is not in any guilds. Add the bot to a server first.');
      } else {
        let guildId = guilds[0].id;
        if (guilds.length > 1) {
          console.log('  Available servers:');
          guilds.forEach((g: any, i: number) => {
            console.log(`    ${i + 1}. ${g.name}`);
          });
          const guildChoice = await prompt('  Select server', '1');
          const guildNum = parseInt(guildChoice, 10);
          if (guildNum > 0 && guildNum <= guilds.length) {
            guildId = guilds[guildNum - 1].id;
          }
        }

        // Create text channel
        const createRes = await fetch(
          `https://discord.com/api/v10/guilds/${guildId}/channels`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bot ${discordToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              name: name,
              type: 0, // GUILD_TEXT
              topic: `TiClaw environment: ${repoFullName}@${branch}`,
            }),
          },
        );

        if (createRes.ok) {
          const channel = await createRes.json() as any;
          discordChannelId = channel.id;
          console.log(`  ✅ Created Discord channel #${name} (ID: ${discordChannelId})`);

          // Send welcome message
          await fetch(
            `https://discord.com/api/v10/channels/${discordChannelId}/messages`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bot ${discordToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                content: `🦀 **TiClaw Environment Ready**\n\n` +
                  `**Repo:** ${repoFullName}\n` +
                  `**Branch:** ${branch}\n` +
                  `**Workspace:** \`${workspaceDir}\`\n\n` +
                  `Mention me to start working on tasks in this repo!`,
              }),
            },
          );
        } else {
          const err = await createRes.text();
          console.log(`  ⚠️  Failed to create channel: ${err}`);
        }
      }
    } catch (err: any) {
      console.log(`  ⚠️  Discord channel creation failed: ${err.message}`);
    }
  } else {
    console.log('  ℹ️  No Discord token found — skipping channel creation');
  }

  // 4. Register group in SQLite
  if (discordChannelId) {
    console.log('\n  📝 Registering group mapping...');
    const config = readConfig();
    const jid = `dc:${discordChannelId}`;
    const assistantName = config.assistant_name || 'Andy';

    try {
      // Import better-sqlite3 dynamically
      const Database = (await import('better-sqlite3')).default;
      fs.mkdirSync(STORE_DIR, { recursive: true });
      const dbPath = path.join(STORE_DIR, 'messages.db');
      const db = new Database(dbPath);

      db.exec(`CREATE TABLE IF NOT EXISTS registered_groups (
        jid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        folder TEXT NOT NULL UNIQUE,
        trigger_pattern TEXT NOT NULL,
        added_at TEXT NOT NULL,
        container_config TEXT,
        requires_trigger INTEGER DEFAULT 1,
        is_main INTEGER DEFAULT 0
      )`);

      db.prepare(
        `INSERT OR REPLACE INTO registered_groups
         (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(
        jid,
        name,
        `${owner}/${repo}/${branch}`,
        `@${assistantName}`,
        new Date().toISOString(),
        0, // requires_trigger = false for dedicated channel
        0,
      );

      db.close();
      console.log(`  ✅ Group registered: #${name} → ${repoFullName}@${branch}`);
    } catch (err: any) {
      console.log(`  ⚠️  SQLite registration failed: ${err.message}`);
    }
  }

  // 5. Save env config
  const envDir = path.join(ENVS_DIR, name);
  fs.mkdirSync(envDir, { recursive: true });
  fs.mkdirSync(path.join(GROUPS_DIR, `${owner}/${repo}/${branch}`, 'logs'), {
    recursive: true,
  });

  const envConfig = {
    repo: repoFullName,
    branch,
    workspace: workspaceDir,
    discord_channel_id: discordChannelId || null,
    created_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(envDir, 'config.yaml'), yaml.stringify(envConfig));

  // Done
  console.log(`\n  🦀 Environment "${name}" ready!`);
  console.log(`  Workspace: ${workspaceDir}`);
  if (discordChannelId) {
    console.log(`  Discord: #${name}`);
    const config = readConfig();
    console.log(
      `  Trigger: @${config.assistant_name || 'Andy'} <your task>`,
    );
  }
  console.log('');
}

// --- List Environments ---

function listEnvs(): void {
  if (!fs.existsSync(ENVS_DIR)) {
    console.log('\n  No environments configured. Run `tc env add <name>` to create one.\n');
    return;
  }

  const entries = fs.readdirSync(ENVS_DIR, { withFileTypes: true });
  const envs = entries.filter((e) => e.isDirectory());

  if (envs.length === 0) {
    console.log('\n  No environments configured. Run `tc env add <name>` to create one.\n');
    return;
  }

  console.log('\n  Environments:\n');
  console.log('  Name              Repo                          Branch    Discord');
  console.log('  ────────────────  ────────────────────────────  ────────  ─────────');

  for (const env of envs) {
    const config = readEnvConfig(env.name);
    const envName = env.name.padEnd(18);
    const repo = (config.repo || '—').padEnd(30);
    const branch = (config.branch || '—').padEnd(10);
    const discord = config.discord_channel_id ? `#${env.name}` : '—';
    console.log(`  ${envName}${repo}${branch}${discord}`);
  }

  console.log('');
}

// --- Remove Environment ---

async function removeEnv(name: string): Promise<void> {
  const envDir = path.join(ENVS_DIR, name);
  if (!fs.existsSync(envDir)) {
    console.error(`  ❌ Environment not found: ${name}`);
    process.exit(1);
  }

  const config = readEnvConfig(name);

  console.log(`\n  🗑  Removing environment: ${name}`);
  if (config.repo) console.log(`  Repo: ${config.repo}`);

  const confirm = await prompt('  Are you sure? (y/N)', 'N');
  if (confirm.toLowerCase() !== 'y') {
    console.log('  Cancelled.\n');
    return;
  }

  // Remove Discord channel if exists
  if (config.discord_channel_id) {
    const discordToken = getDiscordToken();
    if (discordToken) {
      try {
        await fetch(
          `https://discord.com/api/v10/channels/${config.discord_channel_id}`,
          {
            method: 'DELETE',
            headers: { Authorization: `Bot ${discordToken}` },
          },
        );
        console.log(`  ✅ Discord channel #${name} deleted`);
      } catch {
        console.log('  ⚠️  Failed to delete Discord channel');
      }
    }
  }

  // Remove SQLite registration
  if (config.discord_channel_id) {
    try {
      const Database = (await import('better-sqlite3')).default;
      const dbPath = path.join(STORE_DIR, 'messages.db');
      if (fs.existsSync(dbPath)) {
        const db = new Database(dbPath);
        db.prepare('DELETE FROM registered_groups WHERE jid = ?').run(
          `dc:${config.discord_channel_id}`,
        );
        db.close();
        console.log('  ✅ Group registration removed');
      }
    } catch {
      // Ignore
    }
  }

  // Remove env config
  fs.rmSync(envDir, { recursive: true, force: true });
  console.log(`  ✅ Environment config removed`);

  // Optionally remove workspace
  if (config.workspace && fs.existsSync(config.workspace)) {
    const removeWs = await prompt('  Also remove workspace files? (y/N)', 'N');
    if (removeWs.toLowerCase() === 'y') {
      fs.rmSync(config.workspace, { recursive: true, force: true });
      console.log('  ✅ Workspace removed');
    }
  }

  console.log('');
}

// --- Register Command ---

export function registerEnvCommand(program: Command): void {
  const env = program
    .command('env')
    .description('Manage TiClaw environments (repo + channel + workspace)');

  env
    .command('add <name>')
    .description('Create a new environment (clone repo, create Discord channel)')
    .action(addEnv);

  env
    .command('list')
    .description('List all environments')
    .action(listEnvs);

  env
    .command('remove <name>')
    .description('Remove an environment')
    .action(removeEnv);
}
