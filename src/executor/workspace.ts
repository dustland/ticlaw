import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../logger.js';
import chokidar, { FSWatcher } from 'chokidar';
import { DiffSummarizer } from './diff-summarizer.js';
import { PlaywrightVerifier } from './playwright-verifier.js';

const HOME_DIR = os.homedir();
export const FACTORY_DIR = path.join(HOME_DIR, 'aquaclaw', 'factory');

export interface WorkspaceConfig {
  id: string; // Typically the Discord thread ID
  name: string;
  githubUrl?: string;
  onFileAdded?: (filePath: string) => Promise<void>;
  onSummary?: (summary: string) => Promise<void>;
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

  private startWatcher(): void {
    if (this.watcher) return;

    // Watch both screenshots and the root for code changes
    // We ignore node_modules, .git, and common build artifacts
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
        // Code file added
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
