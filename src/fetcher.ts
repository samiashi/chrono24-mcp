import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { config } from "./config.js";
import { diskRead, diskWrite } from "./diskStore.js";
import { chromeUserAgent, FALLBACK_CHROME_MAJOR } from "./userAgent.js";

const UA_DISK = path.join(config.profileDir, "chrono24-ua.json");
// re-probe weekly so the UA major tracks browser updates without paying the
// ~1s probe launch on every cold start
const UA_TTL_S = 7 * 86400;

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

export class ChallengeError extends Error {}

// All Chrono24 requests must stay strictly sequential (one page, polite spacing);
// concurrent MCP tool calls would otherwise interleave page.goto/page.content.
export function createSerializer() {
  let queue: Promise<unknown> = Promise.resolve();
  return function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };
}

const CHALLENGE_TITLE_RE =
  /just a moment|checking your browser|attention required|verifying you are human|please wait/;

export class Fetcher {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private startPromise: Promise<void> | null = null;
  private lastRequestAt = 0;
  private serialize = createSerializer();
  private pendingCount = 0;

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    this.pendingCount++;
    return this.serialize(fn).finally(() => {
      this.pendingCount--;
    });
  }

  private async launch(base: Record<string, unknown>, channel?: string): Promise<BrowserContext> {
    try {
      return await chromium.launchPersistentContext(config.profileDir, {
        ...base,
        ...(channel ? { channel } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/ProcessSingleton|SingletonLock/i.test(msg)) throw err;
      for (const lock of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
        fs.rmSync(path.join(config.profileDir, lock), { force: true });
      }
      console.error("[fetcher] removed stale browser singleton lock");
      return chromium.launchPersistentContext(config.profileDir, {
        ...base,
        ...(channel ? { channel } : {}),
      });
    }
  }

  private start(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.doStart().catch((err) => {
        this.startPromise = null;
        throw err;
      });
    }
    return this.startPromise;
  }

  private headlessUa = new Map<string, string>();

  private async headlessUserAgent(channel?: string): Promise<string> {
    const key = channel ?? "bundled";
    const cached = this.headlessUa.get(key);
    if (cached) return cached;
    const disk = diskRead<string>(UA_DISK, key, UA_TTL_S);
    if (disk && /^Mozilla\/5\.0 .*Chrome\/\d+/.test(disk.value)) {
      this.headlessUa.set(key, disk.value);
      return disk.value;
    }
    let major = FALLBACK_CHROME_MAJOR;
    let probed = false;
    try {
      const probe = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
      const m = probe.version().match(/^(\d+)\./);
      await probe.close();
      if (m) {
        major = Number(m[1]);
        probed = true;
      }
    } catch (err) {
      console.error(
        `[fetcher] browser version probe failed (${err instanceof Error ? err.message : err}), assuming Chrome/${major}`,
      );
    }
    const ua = chromeUserAgent(major);
    this.headlessUa.set(key, ua);
    if (probed) diskWrite(UA_DISK, key, ua, UA_TTL_S);
    return ua;
  }

  private async doStart() {
    fs.mkdirSync(config.profileDir, { recursive: true });
    const base = {
      headless: config.headless,
      locale: "en-US",
      viewport: { width: 1440, height: 900 },
      args: ["--disable-blink-features=AutomationControlled"],
      ignoreDefaultArgs: ["--enable-automation"],
    };
    // headless UAs say "HeadlessChrome" and must be overridden (version-matched
    // via probe); headed browsers keep their native UA - the best fingerprint
    if (config.chromeChannel) {
      try {
        const opts = config.headless ? { ...base, userAgent: await this.headlessUserAgent("chrome") } : base;
        this.context = await this.launch(opts, "chrome");
        this.launchedChannel = "chrome";
        console.error("[fetcher] launched Google Chrome");
      } catch (err) {
        console.error(
          `[fetcher] Google Chrome unavailable (${err instanceof Error ? err.message : err}), falling back to bundled Chromium`,
        );
      }
    }
    if (!this.context) {
      try {
        const opts = config.headless ? { ...base, userAgent: await this.headlessUserAgent() } : base;
        this.context = await this.launch(opts);
        this.launchedChannel = "chromium";
      } catch (err) {
        throw new Error(
          `No browser available. Install Google Chrome, or run "npx playwright install chromium" for the bundled fallback (${err instanceof Error ? err.message : err})`,
          { cause: err },
        );
      }
    }
    this.context.on("close", () => {
      if (!this.closing) {
        console.error("[fetcher] browser context closed; will relaunch on next request");
      }
      this.context = null;
      this.page = null;
      this.startPromise = null;
    });
    if (config.blockAssets) {
      await this.context.route("**/*", (route) => {
        const type = route.request().resourceType();
        const url = route.request().url();
        const blockable = type === "image" || type === "media" || type === "font";
        if (blockable && !url.includes("cloudflare") && !url.includes("/cdn-cgi/")) {
          return route.abort();
        }
        return route.continue();
      });
    }
    await this.context.addInitScript(spoofWebdriver);
    const [first] = this.context.pages();
    this.page = first ?? (await this.context.newPage());
  }

  private async activePage(): Promise<Page> {
    if (!this.context) throw new Error("browser not started");
    if (!this.page || this.page.isClosed()) {
      this.page = await this.context.newPage();
    }
    return this.page;
  }

  private async waitForSlot(delayMs = config.requestDelayMs) {
    const since = Date.now() - this.lastRequestAt;
    const wait = delayMs - since;
    if (wait > 0) await sleep(wait + Math.random() * 500);
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
            "#challenge-form, #challenge-container, #cf-challenge-container, iframe[src*='challenges.cloudflare.com']",
          ),
        ),
      };
    });
  }

  private async settle(page: Page, status: number, onWait?: (message: string) => void) {
    const challengedStatus = status === 403 || status === 503;
    const started = Date.now();
    const deadline = started + config.challengeTimeoutMs;
    // a small body alone (no selector/title/status signal) gets only a short grace
    // period before we accept the page - some legitimate pages are just tiny
    const softDeadline = started + 5000;
    let last: Snapshot | null = null;
    let polls = 0;
    while (Date.now() < deadline) {
      if (polls > 0 && polls % 5 === 0) {
        onWait?.(`waiting for Cloudflare challenge to clear (${Math.round((Date.now() - started) / 1000)}s)`);
      }
      polls++;
      try {
        last = await this.inspect(page);
      } catch {
        // the page navigated mid-inspect (Cloudflare reloads on clearance) - poll again
        await sleep(500);
        continue;
      }
      const hardSignal = last.hasChallengeSelector || CHALLENGE_TITLE_RE.test(last.title);
      const softSignal = last.bodyBytes < 2000;
      if (!hardSignal && !softSignal) return;
      if (!hardSignal && !challengedStatus && Date.now() >= softDeadline) return;
      await sleep(1000);
    }
    throw new ChallengeError(
      `Cloudflare challenge did not clear within ${Math.round(config.challengeTimeoutMs / 1000)}s (title="${last?.title}", bytes=${last?.bodyBytes})`,
    );
  }

  private async navigate(url: string, onWait?: (message: string) => void): Promise<FetchResult> {
    await this.waitForSlot();
    const navStart = Date.now();
    const page = await this.activePage();
    let response: Awaited<ReturnType<Page["goto"]>>;
    try {
      response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: config.navigationTimeoutMs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Navigation failed for ${url}: ${msg}`, { cause: err });
    }
    const status = response?.status() ?? 0;
    await this.settle(page, status, onWait);
    this.telemetryData.pageRequests++;
    this.telemetryData.navMsTotal += Date.now() - navStart;
    const html = await page.content();
    if (config.debug) {
      console.error(`[fetch] ${status} ${url} -> ${page.url()} (${html.length} bytes)`);
    }
    return { status, html, finalUrl: page.url() };
  }

  async fetch(url: string, onWait?: (message: string) => void): Promise<FetchResult> {
    return this.enqueue(async () => {
      await this.start();
      try {
        return await this.navigate(url, onWait);
      } catch (err) {
        if (!(err instanceof ChallengeError)) throw err;
        this.telemetryData.challengeRetries++;
        console.error("[fetcher] challenge hit, warming up on homepage and retrying once");
        onWait?.("Cloudflare challenge hit - warming up on the homepage and retrying");
        try {
          await this.navigate(config.baseUrl + "/", onWait);
        } catch (homeErr) {
          if (!(homeErr instanceof ChallengeError)) throw homeErr;
          // clearance often lands moments after our polling window expires -
          // the final target attempt below usually succeeds anyway
          onWait?.("challenge still up after warmup - one final attempt on the target page");
        }
        return this.navigate(url, onWait);
      }
    });
  }

  async fetchJson(url: string): Promise<{ status: number; body: string }> {
    return this.enqueue(async () => {
      await this.start();
      const host = new URL(config.baseUrl).host;
      const page = await this.activePage();
      if (page.url().includes(host)) {
        await this.waitForSlot(config.jsonDelayMs);
      } else {
        // navigate() already pays the politeness delay for this slot
        await this.navigate(config.baseUrl + "/");
      }
      const result = await (
        await this.activePage()
      ).evaluate(async (u) => {
        const r = await fetch(u, { credentials: "include" });
        return { status: r.status, body: await r.text() };
      }, url);
      this.telemetryData.jsonRequests++;
      if (config.debug) {
        console.error(`[fetchJson] ${result.status} ${url} (${result.body.length} bytes)`);
      }
      return result;
    });
  }

  private launchedChannel: "chrome" | "chromium" | null = null;

  private telemetryData = {
    pageRequests: 0,
    jsonRequests: 0,
    binaryRequests: 0,
    challengeRetries: 0,
    navMsTotal: 0,
  };

  telemetry() {
    const t = this.telemetryData;
    return {
      pageRequests: t.pageRequests,
      jsonRequests: t.jsonRequests,
      binaryRequests: t.binaryRequests,
      challengeRetries: t.challengeRetries,
      avgPageMs: t.pageRequests ? Math.round(t.navMsTotal / t.pageRequests) : null,
    };
  }

  status(): {
    running: boolean;
    channel: "chrome" | "chromium" | null;
    lastRequestAgoS: number | null;
    queuedRequests: number;
  } {
    return {
      running: this.context !== null,
      channel: this.context ? this.launchedChannel : null,
      lastRequestAgoS: this.lastRequestAt ? Math.round((Date.now() - this.lastRequestAt) / 1000) : null,
      queuedRequests: this.pendingCount,
    };
  }

  // CDN asset fetch through the browser's cookie jar (Playwright request API
  // is not subject to page CORS). No politeness delay: this is equivalent to
  // a normal page view loading its own images, but still serialized so it
  // never overlaps a page navigation.
  async fetchBinary(url: string): Promise<{ status: number; contentType: string; base64: string }> {
    return this.enqueue(async () => {
      await this.start();
      if (!this.context) throw new Error("browser not started");
      const res = await this.context.request.get(url, { timeout: 20000, maxRedirects: 3 });
      const status = res.status();
      const contentType = res.headers()["content-type"] ?? "";
      if (status !== 200) return { status, contentType, base64: "" };
      const body = await res.body();
      this.telemetryData.binaryRequests++;
      if (body.length > 2_000_000) return { status, contentType, base64: "" };
      return { status, contentType, base64: body.toString("base64") };
    });
  }

  private closing = false;

  async close() {
    this.closing = true;
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
      this.page = null;
      this.startPromise = null;
    }
  }
}
