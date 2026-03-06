import { spawn, execSync } from 'child_process';
import { logger } from '../core/logger.js';
import { readEnvFile } from '../core/env.js';

function shellEscapeSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

async function runTmux(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmux = spawn('tmux', args);
    tmux.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Tmux ${args[0]} exit code ${code}`));
      }
    });
    tmux.on('error', (err) => {
      reject(err);
    });
  });
}

async function runTmuxAllowCode(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const tmux = spawn('tmux', args);
    tmux.on('close', (code) => {
      resolve(code ?? 1);
    });
    tmux.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Capture the visible tmux pane content.
 * For TUI apps that use alternate screen buffers, this captures the
 * active screen — not the shell scrollback history.
 */
async function runTmuxCapture(sessionId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // -S - captures from the very start of scrollback history
    const tmux = spawn('tmux', ['capture-pane', '-pt', sessionId, '-S', '-']);
    let stdout = '';
    tmux.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    tmux.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`capture-pane exit code ${code}`));
      }
    });
    tmux.on('error', reject);
  });
}

export class TmuxBridge {
  private sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = `tc-${sessionId}`;
  }

  /**
   * Create a new tmux session and launch `gemini -y` (interactive, YOLO mode).
   * If the session already exists, reuse it (but does NOT launch gemini —
   * use launchGemini() separately if needed).
   */
  async createSession(cwd: string, codingCli?: string): Promise<void> {
    const exists = await this.hasSession();
    if (exists) {
      logger.info(
        { sessionId: this.sessionId },
        'Reusing existing tmux session',
      );
      return;
    }

    await runTmux(['new-session', '-d', '-s', this.sessionId, '-c', cwd]);
    // Set generous scrollback so capture-pane can retrieve content well beyond the viewport
    await runTmux([
      'set-option',
      '-t',
      this.sessionId,
      'history-limit',
      '10000',
    ]);
    logger.info({ sessionId: this.sessionId }, 'Tmux session created');

    await this.launchGemini(codingCli);
  }

  /**
   * Launch Gemini in the existing tmux session.
   * Injects env vars first, then starts the CLI.
   */
  async launchGemini(codingCli?: string): Promise<void> {
    const envExports = this.buildEnvExports();

    // Inject env vars before launching gemini
    if (envExports.length > 0) {
      await this.sendRawKeys(`export ${envExports.join(' ')}`);
      await this.sendRawKeys('Enter');
      await new Promise((r) => setTimeout(r, 300));
    }

    // Launch gemini in interactive mode — always ensure -y (YOLO) flag is present
    let cli = codingCli || 'gemini -y';
    if (!cli.includes('-y') && !cli.includes('--yolo')) {
      cli = `${cli} -y`;
    }
    await this.sendRawKeys(cli);
    await this.sendRawKeys('Enter');

    logger.info(
      { sessionId: this.sessionId, cli },
      'Gemini launched in interactive mode',
    );
  }

  /**
   * Build env var exports for proxy, API keys, etc.
   */
  private buildEnvExports(): string[] {
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

    const yamlEnv = readEnvFile(passthrough);

    for (const key of passthrough) {
      const val = process.env[key] || yamlEnv[key];
      if (val) {
        exports.push(`${key}=${shellEscapeSingleQuoted(val)}`);
      }
    }

    // Get GitHub token from gh CLI if not in env
    if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_MCP_PAT) {
      try {
        const token = execSync('gh auth token 2>/dev/null').toString().trim();
        if (token) {
          if (!process.env.GITHUB_TOKEN)
            exports.push(`GITHUB_TOKEN=${shellEscapeSingleQuoted(token)}`);
          if (!process.env.GITHUB_MCP_PAT)
            exports.push(`GITHUB_MCP_PAT=${shellEscapeSingleQuoted(token)}`);
        }
      } catch {
        /* gh not available */
      }
    }

    return exports;
  }

  /**
   * Capture the current visible pane content from the tmux session.
   */
  async capturePaneText(): Promise<string> {
    return runTmuxCapture(this.sessionId);
  }

  async hasSession(): Promise<boolean> {
    const code = await runTmuxAllowCode(['has-session', '-t', this.sessionId]);
    return code === 0;
  }

  async killSession(): Promise<void> {
    const code = await runTmuxAllowCode(['kill-session', '-t', this.sessionId]);
    if (code !== 0) {
      logger.debug(
        { sessionId: this.sessionId, code },
        'Tmux session did not exist during kill',
      );
    }
  }

  /**
   * Send text to the tmux session. For TUI apps like Gemini CLI,
   * send the prompt text first, then call sendEnter() separately.
   */
  async sendRawKeys(keys: string): Promise<void> {
    await runTmux(['send-keys', '-t', this.sessionId, keys]);
  }

  /**
   * Send text followed by Enter to the tmux session.
   * Convenience method for submitting prompts to the Gemini TUI.
   */
  async sendPrompt(text: string): Promise<void> {
    await this.sendRawKeys(text);
    // Small delay to ensure TUI registers the text before Enter
    await new Promise((r) => setTimeout(r, 100));
    await this.sendRawKeys('Enter');
  }

  /** Get the tmux session ID */
  get session(): string {
    return this.sessionId;
  }
}
