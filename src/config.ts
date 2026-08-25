import os from "node:os";
import path from "node:path";

const boolFrom = (v: string | undefined, def: boolean) => (v === undefined ? def : v === "1" || v === "true");

const defaultProfileDir = path.join(os.homedir(), ".cache", "chrono24-mcp", "profile");

export const config = {
  baseUrl: process.env.CHRONO24_BASE_URL ?? "https://www.chrono24.com",
  currencyId: process.env.CURRENCY_ID ?? "USD",
  requestDelayMs: Number(process.env.REQUEST_DELAY_MS ?? 3500),
  headless: boolFrom(process.env.HEADLESS, true),
  chromeChannel: boolFrom(process.env.CHROME_CHANNEL, true),
  profileDir: process.env.PROFILE_DIR ?? defaultProfileDir,
  navigationTimeoutMs: Number(process.env.NAVIGATION_TIMEOUT_MS ?? 45000),
  challengeTimeoutMs: Number(process.env.CHALLENGE_TIMEOUT_MS ?? 45000),
  searchCacheTtlS: Number(process.env.SEARCH_CACHE_TTL_S ?? 180),
  detailCacheTtlS: Number(process.env.DETAIL_CACHE_TTL_S ?? 1800),
  taxonomyCacheTtlS: Number(process.env.TAXONOMY_CACHE_TTL_S ?? 86400),
  maxBatch: Number(process.env.MAX_BATCH ?? 10),
  debug: boolFrom(process.env.DEBUG, false),
};
