import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../logger.js';
import chokidar, { FSWatcher } from 'chokidar';
import { DiffSummarizer } from './diff-summarizer.js';
import { PlaywrightVerifier } from './playwright-verifier.js';
import { exec, execSync } from 'child_process';
import { getMessagesSince } from '../db.js';
import { ASSISTANT_NAME } from '../config.js';

const HOME_DIR = os.homedir();
export const FACTORY_DIR = path.join(HOME_DIR, 'aquaclaw', 'factory');
export const ENV_CONFIG_DIR = path.join(process.cwd(), 'config', 'environments');

export interface WorkspaceConfig {
  id: string; // Typically the Discord thread ID
  name: string;
  githubUrl?: string;
  branch?: string;
  onFileAdded?: (filePath: string) => Promise<void>;
  onSummary?: (summary: string) => Promise<void>;
  onPush?: (prUrl: string) => Promise<void>;
}

export class PortLocker {
  private static startPort = 3000;
  private static endPort = 3050;

  static async getAvailablePort(): Promise<number> {
    const port =
      Math.floor(Math.random() * (this.endPort - this.startPort + 1)) +
      this.startPort;
    return port;
  }
}

export class AcWorkspace {
  private config: WorkspaceConfig;
  public rootDir: string;
  public screenshotsDir: string;
  private watcher: FSWatcher | null = null;
  private summarizer: DiffSummarizer;
  private verifier: PlaywrightVerifier;
  private lastSummaryTime = 0;
  private summaryThrottleMs = 60000; // 1 minute throttle

  constructor(config: WorkspaceConfig) {
    this.config = config;
    this.rootDir = path.join(FACTORY_DIR, config.id);
    this.screenshotsDir = path.join(this.rootDir, 'screenshots');
    this.summarizer = new DiffSummarizer();
    this.verifier = new PlaywrightVerifier();
  }

  async init(): Promise<void> {
    if (!fs.existsSync(this.rootDir)) {
      fs.mkdirSync(this.rootDir, { recursive: true });
      logger.info({ dir: this.rootDir }, 'Created workspace directory');
    }

    if (!fs.existsSync(this.screenshotsDir)) {
      fs.mkdirSync(this.screenshotsDir, { recursive: true });
    }

    // Initialize with a CLAUDE.md if it doesn't exist
    const claudeMdPath = path.join(this.rootDir, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      const content = `# AquaClaw Task: ${this.config.name}\n\nThis is an isolated workspace for task ${this.config.id}.\nURL: ${this.config.githubUrl || 'N/A'}\n`;
      fs.writeFileSync(claudeMdPath, content);
    }

    // Create logs directory
    fs.mkdirSync(path.join(this.rootDir, 'logs'), { recursive: true });

    // Start watching for screenshots and code changes
    this.startWatcher();
  }

  /**
   * Recursive directory copy for environment seeding.
   */
  private copyFolderRecursive(src: string, dest: string): void {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }

    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        this.copyFolderRecursive(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  /**
   * Automates the environment preparation: clone, granular env seeding, and bootstrapping.
   */
  async autoBootstrap(): Promise<{ success: boolean; log: string }> {
    logger.info({ url: this.config.githubUrl }, 'Starting auto-bootstrap');
    let output = '';

    const log = (msg: string) => {
      output += `${msg}\n`;
      logger.info({ id: this.config.id }, msg);
    };

    try {
      // 1. Clone Repo
      if (this.config.githubUrl) {
        log(`Cloning repository: ${this.config.githubUrl}`);
        execSync(`git clone ${this.config.githubUrl} .`, { cwd: this.rootDir });

        if (this.config.branch) {
          log(`Switching to branch: ${this.config.branch}`);
          execSync(`git checkout ${this.config.branch}`, { cwd: this.rootDir });
        }
      }

      // 2. Granular Seeding (Monorepo Aware)
      if (this.config.githubUrl) {
        const repoName = this.config.githubUrl
          .split('/')
          .pop()
          ?.replace('.git', '') || 'default';
        const seedRepoDir = path.join(ENV_CONFIG_DIR, repoName);

        if (fs.existsSync(seedRepoDir) && fs.statSync(seedRepoDir).isDirectory()) {
          log(`Detected granular environment seeds in ${seedRepoDir}. Overlaying...`);
          this.copyFolderRecursive(seedRepoDir, this.rootDir);
        } else {
          // Fallback to single-file seed if it exists (legacy)
          const seedEnvPath = path.join(ENV_CONFIG_DIR, `${repoName}.env`);
          if (fs.existsSync(seedEnvPath)) {
            log(`Seeding root .env from ${seedEnvPath}`);
            fs.copyFileSync(seedEnvPath, path.join(this.rootDir, '.env'));
          } else {
            log(`No granular or root environment seed found for ${repoName}.`);
            // Check for .env.example fallback in the repo
            if (fs.existsSync(path.join(this.rootDir, '.env.example'))) {
              log('Creating root .env from .env.example');
              fs.copyFileSync(
                path.join(this.rootDir, '.env.example'),
                path.join(this.rootDir, '.env'),
              );
            }
          }
        }
      }

      // 3. Run Bootstrap Scripts
      const setupScripts = ['setup.sh', 'bootstrap.sh', 'init.sh'];
      for (const script of setupScripts) {
        const scriptPath = path.join(this.rootDir, script);
        if (fs.existsSync(scriptPath)) {
          log(`Running bootstrap script: ${script}`);
          execSync(`chmod +x ${script} && ./${script}`, { cwd: this.rootDir });
          break; // Only run the first one found
        }
      }

      // 4. Install Dependencies if no script was found but lockfiles exist
      if (!fs.existsSync(path.join(this.rootDir, 'node_modules'))) {
        if (fs.existsSync(path.join(this.rootDir, 'pnpm-lock.yaml'))) {
          log('Detected pnpm, running install...');
          execSync('pnpm install', { cwd: this.rootDir });
        } else if (
          fs.existsSync(path.join(this.rootDir, 'package-lock.json'))
        ) {
          log('Detected npm, running install...');
          execSync('npm install', { cwd: this.rootDir });
        }
      }

      log('Auto-bootstrap completed successfully.');
      return { success: true, log: output };
    } catch (err: any) {
      const errorMsg = `Bootstrap failed: ${err.message}`;
      logger.error({ err }, errorMsg);
      return { success: false, log: output + '\n' + errorMsg };
    }
  }

  private startWatcher(): void {
    if (this.watcher) return;

    this.watcher = chokidar.watch([this.rootDir], {
      ignoreInitial: true,
      persistent: true,
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/logs/**',
        '**/pnpm-lock.yaml',
      ],
    });

    this.watcher.on('add', async (filePath: string) => {
      if (filePath.startsWith(this.screenshotsDir)) {
        logger.info({ filePath }, 'New screenshot detected');
        if (this.config.onFileAdded) {
          try {
            await this.config.onFileAdded(filePath);
          } catch (err) {
            logger.error({ err, filePath }, 'Failed to handle added file');
          }
        }
      } else {
        this.triggerSummary();
      }
    });

    this.watcher.on('change', (filePath: string) => {
      if (!filePath.startsWith(this.screenshotsDir)) {
        this.triggerSummary();
      }
    });
  }

  private async triggerSummary(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSummaryTime < this.summaryThrottleMs) return;
    this.lastSummaryTime = now;

    if (this.config.onSummary) {
      logger.info({ dir: this.rootDir }, 'Triggering diff summary');
      const summary = await this.summarizer.summarize(this.rootDir);
      if (summary) {
        await this.config.onSummary(summary);
      }
    }
  }

  async verify(url: string, label: string): Promise<void> {
    logger.info({ url, label }, 'Running Playwright verification');
    await this.verifier.captureScreenshot(url, this.screenshotsDir, label);
  }

  async push(): Promise<string | null> {
    logger.info({ dir: this.rootDir }, 'Creating GitHub PR');

    // 1. Get history for description
    const messages = getMessagesSince(
      `dc:${this.config.id}`,
      '',
      ASSISTANT_NAME,
    );
    const historyText = messages
      .map((m) => `${m.sender_name}: ${m.content}`)
      .join('\n');

    // 2. Generate PR description using Gemini
    const diffSummary = await this.summarizer.summarize(this.rootDir);
    const prBody = `
## AquaClaw AI PR

**Summary:** ${diffSummary || 'AI-generated changes'}

**Reasoning & Context (from Discord):**
${historyText.slice(-2000)}

---
*Created automatically by AquaClaw 🦀*
    `;

    const prTitle = `feat: AquaClaw task - ${this.config.name}`;

    return new Promise((resolve) => {
      const cmd = `gh pr create --title "${prTitle}" --body "${prBody}"`;
      exec(cmd, { cwd: this.rootDir }, (err, stdout) => {
        if (err) {
          logger.error({ err, cmd }, 'Failed to create PR');
          resolve(null);
        } else {
          const prUrl = stdout.trim();
          logger.info({ prUrl }, 'GitHub PR created');
          if (this.config.onPush) {
            this.config.onPush(prUrl);
          }
          resolve(prUrl);
        }
      });
    });
  }

  async applySkill(
    skillName: string,
  ): Promise<{ success: boolean; error?: string }> {
    logger.info(
      { dir: this.rootDir, skill: skillName },
      'Applying skill to workspace',
    );

    const projectRoot = process.cwd();
    const skillPath = path.join(projectRoot, '.claude', 'skills', skillName);

    if (!fs.existsSync(skillPath)) {
      return { success: false, error: `Skill not found: ${skillName}` };
    }

    return new Promise((resolve) => {
      const cmd = `pnpm dlx tsx ${path.join(projectRoot, 'scripts', 'apply-skill.ts')} ${skillPath}`;
      exec(cmd, { cwd: this.rootDir }, (err, _stdout, stderr) => {
        if (err) {
          logger.error({ err, stderr, cmd }, 'Failed to apply skill');
          resolve({ success: false, error: stderr || err.message });
        } else {
          logger.info({ skill: skillName }, 'Skill applied successfully');
          resolve({ success: true });
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    await this.verifier.close();
  }

  async getEnv(): Promise<Record<string, string>> {
    const port = await PortLocker.getAvailablePort();
    return {
      PORT: port.toString(),
      AC_TASK_ID: this.config.id,
      AC_WORKSPACE_ROOT: this.rootDir,
    };
  }
}
