import { spawn, exec } from 'child_process';
import { logger } from '../logger.js';

export class TmuxBridge {
  private sessionId: string;
  private onData: (data: string) => void;

  constructor(sessionId: string, onData: (data: string) => void) {
    this.sessionId = `ac-${sessionId}`;
    this.onData = onData;
  }

  async createSession(cwd: string, command: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Create a new detached tmux session
      // -d: detached
      // -s: session name
      // -c: start directory
      const tmux = spawn('tmux', [
        'new-session',
        '-d',
        '-s',
        this.sessionId,
        '-c',
        cwd,
        command,
      ]);

      tmux.on('close', (code) => {
        if (code === 0) {
          logger.info({ sessionId: this.sessionId }, 'Tmux session created');
          this.startStreaming();
          resolve();
        } else {
          logger.error({ code }, 'Failed to create tmux session');
          reject(new Error(`Tmux exit code ${code}`));
        }
      });
    });
  }

  private startStreaming(): void {
    // We use 'tmux pipe-pane' or 'tmux capture-pane' to get output.
    // For live streaming, we can use a small loop or 'tmux pipe-pane -t {session} "cat >> {pipe}"'
    // For simplicity in this prototype, we'll use a 'tmux capture-pane' polling approach
    // or a tail -f on a log file if we redirect command output.

    // Better approach: spawn a process that tails the tmux pipe
    logger.info({ sessionId: this.sessionId }, 'Starting tmux stream');

    // Capture pane periodically for now (simplest for prototype)
    const interval = setInterval(async () => {
      try {
        const hasSession = await this.hasSession();
        if (!hasSession) {
          clearInterval(interval);
          return;
        }

        // Capture last 5 lines
        exec(`tmux capture-pane -pt ${this.sessionId} -S -5`, (err, stdout) => {
          if (!err && stdout.trim()) {
            this.onData(stdout);
          }
        });
      } catch (err) {
        clearInterval(interval);
      }
    }, 2000);
  }

  async hasSession(): Promise<boolean> {
    return new Promise((resolve) => {
      exec(`tmux has-session -t ${this.sessionId}`, (err) => {
        resolve(!err);
      });
    });
  }

  async killSession(): Promise<void> {
    return new Promise((resolve) => {
      exec(`tmux kill-session -t ${this.sessionId}`, () => {
        resolve();
      });
    });
  }

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
}
