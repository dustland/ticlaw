/**
 * `tc start/stop/status` — Control the TiClaw system service.
 *
 * Wraps the existing setup/service.ts for launchd (macOS) and systemd (Linux).
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  readConfig,
  PROJECT_ROOT,
  HOME_DIR,
  TICLAW_HOME,
  CONFIG_PATH,
} from './utils.js';

function getPlatform(): 'macos' | 'linux' | 'unknown' {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') return 'linux';
  return 'unknown';
}

function isRoot(): boolean {
  return process.getuid?.() === 0;
}

const LAUNCHD_PLIST = path.join(
  HOME_DIR,
  'Library',
  'LaunchAgents',
  'com.ticlaw.plist',
);

function getSystemdUnit(): string {
  return 'ticlaw.service';
}

// --- Start ---

export async function start(): Promise<void> {
  const platform = getPlatform();

  console.log('\n  🚀 Starting TiClaw service...\n');

  if (platform === 'macos') {
    if (!fs.existsSync(LAUNCHD_PLIST)) {
      console.log('  Service not installed. Run `tc bootstrap` first.');
      process.exit(1);
    }
    try {
      execSync(`launchctl load ${LAUNCHD_PLIST}`, { stdio: 'inherit' });
      console.log('  ✅ Service loaded (launchd)');
    } catch {
      try {
        const uid = execSync('id -u', { encoding: 'utf-8' }).trim();
        execSync(`launchctl kickstart -k gui/${uid}/com.ticlaw`, {
          stdio: 'inherit',
        });
        console.log('  ✅ Service restarted (launchd)');
      } catch {
        console.error('  ❌ Failed to start service');
        process.exit(1);
      }
    }
  } else if (platform === 'linux') {
    const unit = getSystemdUnit();
    try {
      if (isRoot()) {
        execSync(`systemctl start ${unit}`, { stdio: 'inherit' });
      } else {
        execSync(`systemctl --user start ${unit}`, { stdio: 'inherit' });
      }
      console.log('  ✅ Service started (systemd)');
    } catch {
      console.log('  systemd failed. Starting directly...');
      const logDir = path.join(TICLAW_HOME, 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      execSync(`nohup node dist/index.js > ${logDir}/ticlaw.log 2>&1 &`, {
        cwd: PROJECT_ROOT,
        stdio: 'ignore',
      });
      console.log('  ✅ Service started (nohup fallback)');
    }
  } else {
    console.error('  Unsupported platform');
    process.exit(1);
  }
}

// --- Stop ---

export async function stop(): Promise<void> {
  const platform = getPlatform();

  console.log('\n  🛑 Stopping TiClaw service...\n');

  if (platform === 'macos') {
    try {
      execSync(`launchctl unload ${LAUNCHD_PLIST}`, { stdio: 'inherit' });
      console.log('  ✅ Service stopped (launchd)');
    } catch {
      console.log('  Service was not running');
    }
  } else if (platform === 'linux') {
    const unit = getSystemdUnit();
    try {
      if (isRoot()) {
        execSync(`systemctl stop ${unit}`, { stdio: 'inherit' });
      } else {
        execSync(`systemctl --user stop ${unit}`, { stdio: 'inherit' });
      }
      console.log('  ✅ Service stopped (systemd)');
    } catch {
      try {
        execSync("pkill -f 'node dist/index.js'", { stdio: 'ignore' });
        console.log('  ✅ Process killed');
      } catch {
        console.log('  Service was not running');
      }
    }
  }
}

// --- Status ---

export async function status(): Promise<void> {
  const platform = getPlatform();
  const config = readConfig();

  console.log('\n  🦀 TiClaw Status\n');

  // Service status
  if (platform === 'macos') {
    try {
      const output = execSync('launchctl list | grep ticlaw', {
        encoding: 'utf-8',
      });
      const parts = output.trim().split('\t');
      const pid = parts[0];
      const running = pid !== '-';
      console.log(`  Service: ${running ? '🟢 Running' : '🔴 Stopped'} (PID: ${pid})`);
    } catch {
      console.log('  Service: 🔴 Not installed');
    }
  } else if (platform === 'linux') {
    try {
      const unit = getSystemdUnit();
      const cmd = isRoot() ? `systemctl is-active ${unit}` : `systemctl --user is-active ${unit}`;
      const state = execSync(cmd, { encoding: 'utf-8' }).trim();
      console.log(`  Service: ${state === 'active' ? '🟢 Running' : '🔴 ' + state}`);
    } catch {
      console.log('  Service: 🔴 Not installed');
    }
  }

  // Detect coding CLIs
  console.log('\n  Coding CLIs:');
  for (const cli of ['gemini', 'claude', 'codex', 'gh']) {
    try {
      execSync(`command -v ${cli}`, { stdio: 'ignore' });
      const label = cli === 'gemini' ? `${cli} (primary)` : cli;
      console.log(`    ✅ ${label}`);
    } catch {
      console.log(`    ❌ ${cli}`);
    }
  }

  // Channels from config.yaml
  console.log('\n  Channels:');
  const channelList = [
    { key: 'discord', name: 'Discord' },
    { key: 'telegram', name: 'Telegram' },
    { key: 'slack', name: 'Slack' },
    { key: 'whatsapp', name: 'WhatsApp' },
  ];
  for (const ch of channelList) {
    const configured = config.channels?.[ch.key]?.token;
    console.log(`    ${configured ? '✅' : '──'} ${ch.name}`);
  }

  // Config summary
  console.log('\n  Config:');
  console.log(`    File: ${fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : '(not found — run tc bootstrap)'}`);
  if (config.coding_cli) console.log(`    Coding CLI: ${config.coding_cli}`);
  if (config.assistant_name) console.log(`    Assistant: ${config.assistant_name}`);
  if (config.proxy) console.log(`    Proxy: ${config.proxy}`);

  console.log('');
}
