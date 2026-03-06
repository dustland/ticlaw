import fs from 'fs';
import { logger } from '../core/logger.js';
import { RegisteredProject } from '../core/types.js';
import { TmuxBridge } from './tmux.js';

export interface ExecutorOptions {
  group: RegisteredProject;
  workspacePath: string;
  codingCli?: string;
  /** String that appears in the terminal when the CLI is idle and ready for input */
  idleIndicator?: string;
}

/**
 * Thin wrapper around a tmux session.
 * Operations: create session, send keys, capture screen, monitor for idle.
 *
 * The idle indicator is the one piece of per-CLI configuration —
 * it tells us when the CLI is done working (e.g., "Type your message" for Gemini).
 */
export class Executor {
  private opts: ExecutorOptions;
  private bridge: TmuxBridge;
  private idleIndicator: string;

  constructor(opts: ExecutorOptions) {
    this.opts = opts;
    this.bridge = new TmuxBridge(opts.group.folder);
    this.idleIndicator = opts.idleIndicator || 'Type your message';
  }

  /**
   * Ensure a tmux session exists. If not, create one and launch the CLI.
   */
  async ensureSession(): Promise<void> {
    const { workspacePath, codingCli } = this.opts;

    if (!fs.existsSync(workspacePath)) {
      fs.mkdirSync(workspacePath, { recursive: true });
    }

    const exists = await this.bridge.hasSession();
    if (!exists) {
      await this.bridge.createSession(workspacePath, codingCli);
      logger.info({ sessionId: this.bridge.session }, 'Session created');
    }
  }

  /**
   * Capture the current screen content of the session.
   * Returns raw text — the caller interprets it.
   */
  async capture(): Promise<string> {
    await this.ensureSession();
    return this.bridge.capturePaneText();
  }

  /**
   * Send a prompt (text + Enter) to the session.
   * Returns immediately — does NOT wait for a response.
   */
  async send(prompt: string): Promise<void> {
    await this.ensureSession();
    await this.bridge.sendPrompt(prompt);
    logger.info({ sessionId: this.bridge.session }, 'Text sent to session');
  }

  /**
   * Poll the pane until the CLI's idle indicator appears.
   * Blocks until idle (used by captureSessionTool with waitForIdle=true).
   */
  async waitForIdle(
    timeoutMs: number = 600_000,
    pollMs: number = 3000,
  ): Promise<string> {
    await this.ensureSession();

    const start = Date.now();
    let lastLog = 0;

    while (Date.now() - start < timeoutMs) {
      const pane = await this.bridge.capturePaneText();

      if (pane.includes(this.idleIndicator)) {
        logger.info(
          { elapsed: Date.now() - start, paneLength: pane.length },
          'CLI is idle',
        );
        return pane;
      }

      if (Date.now() - lastLog > 30_000) {
        logger.info(
          { elapsed: Date.now() - start, paneLength: pane.length },
          'Waiting for CLI to become idle...',
        );
        lastLog = Date.now();
      }

      await new Promise((r) => setTimeout(r, pollMs));
    }

    const finalPane = await this.bridge.capturePaneText();
    logger.warn(
      { elapsed: Date.now() - start, paneLength: finalPane.length },
      'Timed out waiting for idle',
    );
    return finalPane;
  }

  /**
   * Active monitor ID — used to cancel stale monitors when a new prompt is sent.
   * Only the monitor whose ID matches this will fire the callback.
   */
  private _activeMonitorId: number = 0;

  /**
   * Start a non-blocking background monitor that polls the pane
   * and calls `onIdle` when the CLI finishes processing.
   *
   * Two-phase approach:
   *   Phase 1: Wait for idle indicator to DISAPPEAR (Gemini started working)
   *   Phase 2: Wait for idle indicator to REAPPEAR (Gemini finished)
   *
   * During Phase 2, fires `onProgress(screen, elapsedMs)` periodically
   * so the caller can send status updates to Discord.
   *
   * This prevents delivering stale responses from a previous task.
   * Starting a new monitor cancels any previous one.
   */
  monitorForIdle(
    onIdle: (screen: string) => void,
    opts?: {
      timeoutMs?: number;
      pollMs?: number;
      onProgress?: (screen: string, elapsedMs: number) => void;
      progressIntervalMs?: number;
    },
  ): void {
    const timeoutMs = opts?.timeoutMs ?? 600_000;
    const pollMs = opts?.pollMs ?? 3000;
    const onProgress = opts?.onProgress;
    const progressIntervalMs = opts?.progressIntervalMs ?? 30_000;

    // Cancel any previous monitor
    const monitorId = ++this._activeMonitorId;
    const start = Date.now();
    let phase: 'wait-for-busy' | 'wait-for-idle' = 'wait-for-busy';
    let lastLog = 0;
    let lastProgress = 0;

    logger.info({ monitorId }, 'Monitor: starting (phase 1: wait for busy)');

    const poll = async () => {
      // If a newer monitor was started, abort this one silently
      if (this._activeMonitorId !== monitorId) {
        logger.info(
          { monitorId },
          'Monitor: cancelled (newer monitor started)',
        );
        return;
      }

      try {
        const pane = await this.bridge.capturePaneText();
        const isIdle = pane.includes(this.idleIndicator);

        if (phase === 'wait-for-busy') {
          if (!isIdle) {
            // Gemini started processing — move to phase 2
            phase = 'wait-for-idle';
            logger.info(
              { monitorId, elapsed: Date.now() - start },
              'Monitor: Gemini is busy (phase 2: wait for idle)',
            );
          } else if (Date.now() - start > 10_000) {
            // After 10s, if still idle, Gemini may have processed instantly
            // (e.g., very fast response) — treat as done
            logger.info(
              { monitorId, elapsed: Date.now() - start },
              'Monitor: still idle after 10s, treating as done',
            );
            if (this._activeMonitorId === monitorId) {
              onIdle(pane);
            }
            return;
          }
        }

        if (phase === 'wait-for-idle' && isIdle) {
          // Gemini finished — deliver the response
          logger.info(
            { monitorId, elapsed: Date.now() - start, paneLength: pane.length },
            'Monitor: CLI is idle (done)',
          );
          if (this._activeMonitorId === monitorId) {
            onIdle(pane);
          }
          return;
        }

        // Fire progress callback during Phase 2
        if (
          phase === 'wait-for-idle' &&
          onProgress &&
          Date.now() - lastProgress >= progressIntervalMs
        ) {
          lastProgress = Date.now();
          try {
            onProgress(pane, Date.now() - start);
          } catch (err) {
            logger.warn({ err, monitorId }, 'onProgress callback error');
          }
        }

        // Timeout check
        if (Date.now() - start >= timeoutMs) {
          logger.warn(
            { monitorId, elapsed: Date.now() - start, phase },
            'Monitor: timed out',
          );
          if (this._activeMonitorId === monitorId) {
            onIdle(pane);
          }
          return;
        }

        // Progress logging every 30s
        if (Date.now() - lastLog > 30_000) {
          logger.info(
            {
              monitorId,
              elapsed: Date.now() - start,
              phase,
              paneLength: pane.length,
            },
            'Monitor: still waiting...',
          );
          lastLog = Date.now();
        }

        // Schedule next poll
        setTimeout(() => {
          poll().catch((err) => {
            logger.error({ err, monitorId }, 'Monitor poll error');
            if (this._activeMonitorId === monitorId) {
              onIdle(
                `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
              );
            }
          });
        }, pollMs);
      } catch (err) {
        logger.error({ err, monitorId }, 'Monitor poll error');
        if (this._activeMonitorId === monitorId) {
          onIdle(
            `Error: ${err instanceof Error ? (err as Error).message : 'Unknown error'}`,
          );
        }
      }
    };

    // Start first poll immediately
    poll().catch((err) => {
      logger.error({ err, monitorId }, 'Monitor start error');
      if (this._activeMonitorId === monitorId) {
        onIdle(
          `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
        );
      }
    });
  }

  async killSession(): Promise<void> {
    await this.bridge.killSession();
  }
}
