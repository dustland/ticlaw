import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../logger.js';

const HOME_DIR = os.homedir();
export const FACTORY_DIR = path.join(HOME_DIR, 'aquaclaw', 'factory');

export interface WorkspaceConfig {
  id: string; // Typically the Discord thread ID
  name: string;
  githubUrl?: string;
}

export class PortLocker {
  private static startPort = 3000;
  private static endPort = 3050;

  static async getAvailablePort(): Promise<number> {
    // In a real implementation, we'd check if the port is actually in use.
    // For now, we'll use a simple file-based lock or just a random available port.
    // Let's implement a simple random selection for the prototype.
    const port =
      Math.floor(Math.random() * (this.endPort - this.startPort + 1)) +
      this.startPort;
    return port;
  }
}

export class AcWorkspace {
  private config: WorkspaceConfig;
  public rootDir: string;

  constructor(config: WorkspaceConfig) {
    this.config = config;
    this.rootDir = path.join(FACTORY_DIR, config.id);
  }

  async init(): Promise<void> {
    if (!fs.existsSync(this.rootDir)) {
      fs.mkdirSync(this.rootDir, { recursive: true });
      logger.info({ dir: this.rootDir }, 'Created workspace directory');
    }

    // Initialize with a CLAUDE.md if it doesn't exist
    const claudeMdPath = path.join(this.rootDir, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      const content = `# AquaClaw Task: ${this.config.name}

This is an isolated workspace for task ${this.config.id}.
URL: ${this.config.githubUrl || 'N/A'}
`;
      fs.writeFileSync(claudeMdPath, content);
    }

    // Create logs directory
    fs.mkdirSync(path.join(this.rootDir, 'logs'), { recursive: true });
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
