import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../logger.js';
import chokidar, { FSWatcher } from 'chokidar';

const HOME_DIR = os.homedir();
export const FACTORY_DIR = path.join(HOME_DIR, 'aquaclaw', 'factory');

export interface WorkspaceConfig {
  id: string; // Typically the Discord thread ID
  name: string;
  githubUrl?: string;
  onFileAdded?: (filePath: string) => Promise<void>;
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

  constructor(config: WorkspaceConfig) {
    this.config = config;
    this.rootDir = path.join(FACTORY_DIR, config.id);
    this.screenshotsDir = path.join(this.rootDir, 'screenshots');
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

    // Start watching for screenshots
    this.startWatcher();
  }

  private startWatcher(): void {
    if (this.watcher) return;

    this.watcher = chokidar.watch(this.screenshotsDir, {
      ignoreInitial: true,
      persistent: true,
    });

    this.watcher.on('add', async (filePath: string) => {
      logger.info({ filePath }, 'New screenshot detected');
      if (this.config.onFileAdded) {
        try {
          await this.config.onFileAdded(filePath);
        } catch (err) {
          logger.error({ err, filePath }, 'Failed to handle added file');
        }
      }
    });
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
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
