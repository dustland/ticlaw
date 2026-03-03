import { chromium, Browser, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import { logger } from '../logger.js';

export interface VerificationResult {
  screenshotPath: string;
  timestamp: string;
}

export class PlaywrightVerifier {
  private browser: Browser | null = null;

  async init(): Promise<void> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: true });
    }
  }

  async captureScreenshot(
    url: string,
    outputDir: string,
    label: string,
  ): Promise<VerificationResult | null> {
    await this.init();
    if (!this.browser) return null;

    const timestamp = Date.now().toString();
    const screenshotPath = path.join(outputDir, `${label}-${timestamp}.png`);
    
    // Ensure output dir exists
    fs.mkdirSync(outputDir, { recursive: true });

    let page: Page | null = null;
    try {
      page = await this.browser.newPage();
      // Set a reasonable viewport for a Mac Mini R&D environment
      await page.setViewportSize({ width: 1280, height: 800 });
      
      logger.info({ url, label }, 'Playwright: Navigating to URL');
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      
      // Wait a bit for any animations
      await page.waitForTimeout(2000);
      
      await page.screenshot({ path: screenshotPath, fullPage: true });
      logger.info({ screenshotPath }, 'Playwright: Screenshot captured');
      
      return {
        screenshotPath,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      logger.error({ err, url, label }, 'Playwright: Failed to capture screenshot');
      return null;
    } finally {
      if (page) await page.close();
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
