import fs from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright";
import { config } from "./config.js";
import { CHRONO24_USER_AGENT } from "./userAgent.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function spoofWebdriver() {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
}

export interface FetchResult {
  status: number;
  html: string;
  finalUrl: string;
}

interface Snapshot {
  title: string;
  bodyBytes: number;
  hasChallengeSelector: boolean;
}

export class Fetcher {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private lastRequestAt = 0;
  private warmedUp = false;

  private async start() {
    if (this.context) return;
    fs.mkdirSync(config.profileDir, { recursive: true });
    const base = {
      headless: config.headless,
      locale: "en-US",
      viewport: { width: 1440, height: 900 },
      userAgent: CHRONO24_USER_AGENT,
      args: ["--disable-blink-features=AutomationControlled"],
      ignoreDefaultArgs: ["--enable-automation"],
    };
    try {
      if (config.chromeChannel) {
        this.context = await chromium.launchPersistentContext(config.profileDir, {
          ...base,
          channel: "chrome",
        });
        console.error("[fetcher] launched Google Chrome");
      }
    } catch (err) {
      console.error(
        `[fetcher] Google Chrome unavailable (${err instanceof Error ? err.message : err}), falling back to bundled Chromium`
      );
    }
    if (!this.context) {
      this.context = await chromium.launchPersistentContext(config.profileDir, base);
    }
    await this.context.addInitScript(spoofWebdriver);
    const [first] = this.context.pages();
    this.page = first ?? (await this.context.newPage());
  }

  private async waitForSlot() {
    const since = Date.now() - this.lastRequestAt;
    const delayMs = Math.max(0, config.requestDelayMs - since) + Math.random() * 500;
    if (delayMs > 0) await sleep(delayMs);
    this.lastRequestAt = Date.now();
  }

  private async inspect(page: Page): Promise<Snapshot> {
    return page.evaluate(() => {
      const title = document.title.toLowerCase();
      const bodyText = (document.body?.innerText ?? "").trim();
      return {
        title,
        bodyBytes: bodyText.length,
        hasChallengeSelector: Boolean(
          document.querySelector(
            "#challenge-form, #challenge-container, #cf-challenge-container, iframe[src*='challenges.cloudflare.com']"
          )
        ),
      };
    });
  }

  private isChallenged(s: Snapshot) {
    return (
      s.hasChallengeSelector ||
      /just a moment|checking your browser|attention required|verifying you are human|please wait/.test(
        s.title
      ) ||
      s.bodyBytes < 2000
    );
  }

  private async settle(page: Page) {
    const deadline = Date.now() + config.challengeTimeoutMs;
    while (Date.now() < deadline) {
      const snapshot = await this.inspect(page);
      if (!this.isChallenged(snapshot)) return;
      await sleep(1000);
    }
    const last = await this.inspect(page);
    throw new Error(
      `Cloudflare challenge did not clear within ${Math.round(config.challengeTimeoutMs / 1000)}s (title="${last.title}", bytes=${last.bodyBytes})`
    );
  }

  private async navigate(url: string): Promise<FetchResult> {
    await this.waitForSlot();
    const page = this.page!;
    let status = 0;
    try {
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: config.navigationTimeoutMs,
      });
      status = response?.status() ?? 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Navigation failed for ${url}: ${msg}`);
    }
    await this.settle(page);
    const html = await page.content();
    if (config.debug) {
      console.error(`[fetch] ${status} ${url} -> ${page.url()} (${html.length} bytes)`);
    }
    return { status, html, finalUrl: page.url() };
  }

  async fetch(url: string): Promise<FetchResult> {
    await this.start();
    if (!this.warmedUp) {
      this.warmedUp = true;
      try {
        await this.navigate(config.baseUrl + "/");
      } catch (err) {
        console.error(`[fetcher] warmup skipped: ${err instanceof Error ? err.message : err}`);
      }
    }
    return this.navigate(url);
  }

  async close() {
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
      this.page = null;
    }
  }
}