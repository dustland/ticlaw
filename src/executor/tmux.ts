import { spawn, exec, execSync, ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from '../core/logger.js';

export class TmuxBridge {
  private sessionId: string;
  private onData: (data: string) => void;
  private tailProc: ChildProcess | null = null;
  private outputFile: string;

  constructor(sessionId: string, onData: (data: string) => void) {
    this.sessionId = `tc-${sessionId}`;
    this.onData = onData;
    this.outputFile = path.join(os.tmpdir(), `ticlaw-${this.sessionId}.log`);
  }

  async createSession(cwd: string): Promise<void> {
    // Check if session already exists — reuse it
    const exists = await this.hasSession();
    if (exists) {
      logger.info(
        { sessionId: this.sessionId },
        'Reusing existing tmux session',
      );
      this.startTailing();
      return;
    }

    return new Promise((resolve, reject) => {
      const tmux = spawn('tmux', [
        'new-session',
        '-d',
        '-s',
        this.sessionId,
        '-c',
        cwd,
      ]);

      tmux.on('close', async (code) => {
        if (code === 0) {
          logger.info({ sessionId: this.sessionId }, 'Tmux session created');
          await this.injectEnv();
          resolve();
        } else {
          logger.error({ code }, 'Failed to create tmux session');
          reject(new Error(`Tmux exit code ${code}`));
        }
      });
    });
  }

  /**
   * Inject key env vars into the tmux session's running shell.
   * Uses sendKeys with export to ensure the shell actually picks them up
   * (tmux set-environment only affects NEW panes, not the current shell).
   */
  private async injectEnv(): Promise<void> {
    const exports: string[] = [];

    const passthrough = [
      'http_proxy',
      'https_proxy',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
      'no_proxy',
      'GOOGLE_API_KEY',
      'GEMINI_API_KEY',
      'GITHUB_TOKEN',
      'GITHUB_MCP_PAT',
    ];

    // Import readEnvFile dynamically or statically to read from config.yaml
    const { readEnvFile } = await import('../core/env.js');
    const yamlEnv = readEnvFile(passthrough);

    for (const key of passthrough) {
      const val = process.env[key] || yamlEnv[key];
      if (val) {
        exports.push(`${key}='${val.replace(/'/g, "'\\''")}'`);
      }
    }

    // Get GitHub token from gh CLI if not in env
    if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_MCP_PAT) {
      try {
        const token = execSync('gh auth token 2>/dev/null').toString().trim();
        if (token) {
          if (!process.env.GITHUB_TOKEN)
            exports.push(`GITHUB_TOKEN='${token.replace(/'/g, "'\\''")}'`);
          if (!process.env.GITHUB_MCP_PAT)
            exports.push(`GITHUB_MCP_PAT='${token.replace(/'/g, "'\\''")}'`);
        }
      } catch {
        /* gh not available */
      }
    }

    if (exports.length > 0) {
      await this.sendKeys(`export ${exports.join(' ')}`);
    }
  }

  /**
   * Start tailing the output file. Only captures agent-runner stdout,
   * not shell prompts or ANSI codes.
   */
  startTailing(): void {
    if (this.tailProc) return; // already tailing

    logger.info(
      { sessionId: this.sessionId, outputFile: this.outputFile },
      'Tailing agent output file',
    );

    // Ensure file exists
    fs.writeFileSync(this.outputFile, '', { flag: 'a' });

    this.tailProc = spawn('tail', ['-f', this.outputFile]);
    this.tailProc.stdout?.on('data', (data: Buffer) => {
      this.onData(data.toString());
    });
    this.tailProc.on('close', () => {
      this.tailProc = null;
    });
  }

  async hasSession(): Promise<boolean> {
    return new Promise((resolve) => {
      // Using execFile or spawn is safer than exec to prevent injection
      const tmux = spawn('tmux', ['has-session', '-t', this.sessionId]);
      tmux.on('close', (code) => {
        resolve(code === 0);
      });
      // Handle error so node doesn't crash if tmux is not installed
      tmux.on('error', () => {
        resolve(false);
      });
    });
  }

  async killSession(): Promise<void> {
    this.tailProc?.kill();
    this.tailProc = null;
    try {
      fs.unlinkSync(this.outputFile);
    } catch {
      /* ignore */
    }
    return new Promise((resolve) => {
      const tmux = spawn('tmux', ['kill-session', '-t', this.sessionId]);
      tmux.on('close', () => {
        resolve();
      });
      tmux.on('error', () => {
        resolve();
      });
    });
  }

  /**
   * Send a command to the tmux session, redirecting stdout to the output file.
   * To capture output, append ` >> {outputFile} 2>&1` to the command.
   */
  async sendKeys(keys: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const tmux = spawn('tmux', [
        'send-keys',
        '-t',
        this.sessionId,
        keys,
        'C-m',
      ]);
      tmux.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Tmux send-keys exit code ${code}`));
      });
    });
  }

  /** Get the output file path so callers can redirect command output to it. */
  get outputPath(): string {
    return this.outputFile;
  }
}
