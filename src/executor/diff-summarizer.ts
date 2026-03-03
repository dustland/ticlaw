import { GoogleGenerativeAI } from '@google/generative-ai';
import { exec } from 'child_process';
import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';

export class DiffSummarizer {
  private genAI: GoogleGenerativeAI | null = null;
  private model: any = null;

  constructor() {
    const env = readEnvFile(['AC_GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY']);
    const apiKey = env.AC_GEMINI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.AC_GEMINI_API_KEY;
    
    if (apiKey) {
      this.genAI = new GoogleGenerativeAI(apiKey);
      this.model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    } else {
      logger.warn('DiffSummarizer: AC_GEMINI_API_KEY not set, summaries will be disabled');
    }
  }

  async summarize(cwd: string): Promise<string | null> {
    if (!this.model) return null;

    try {
      const diff = await this.getDiff(cwd);
      if (!diff || diff.trim().length === 0) return null;

      const prompt = `
        Summarize the following git diff in a single concise sentence for a developer notification.
        Focus on "what" changed and "why" if evident. Use plain English.
        
        DIFF:
        ${diff.slice(0, 10000)}
      `;

      const result = await this.model.generateContent(prompt);
      const summary = result.response.text().trim();
      return summary;
    } catch (err) {
      logger.error({ err }, 'Failed to generate diff summary');
      return null;
    }
  }

  private async getDiff(cwd: string): Promise<string> {
    return new Promise((resolve) => {
      // Use git diff --stat for a high level view if diff is too large,
      // but here we try to get the actual changes for Gemini to summarize.
      exec('git diff HEAD', { cwd, timeout: 5000 }, (err, stdout) => {
        if (err) {
          // If not a git repo or other error, fallback to empty
          resolve('');
        } else {
          resolve(stdout);
        }
      });
    });
  }
}
