import os from "node:os";
import path from "node:path";

const boolFrom = (v: string | undefined, def: boolean) => (v === undefined ? def : v === "1" || v === "true");

export const numFrom = (name: string, v: string | undefined, def: number, min = 0): number => {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) {
    console.error(`[config] ignoring invalid ${name}="${v}" (min ${min}), using default ${def}`);
    return def;
  }
  return n;
};

const defaultProfileDir = path.join(os.homedir(), ".cache", "chrono24-mcp", "profile");

export const config = {
  baseUrl: process.env.CHRONO24_BASE_URL ?? "https://www.chrono24.com",
  currencyId: process.env.CURRENCY_ID ?? "USD",
  requestDelayMs: numFrom("REQUEST_DELAY_MS", process.env.REQUEST_DELAY_MS, 3500),
  headless: boolFrom(process.env.HEADLESS, true),
  chromeChannel: boolFrom(process.env.CHROME_CHANNEL, true),
  profileDir: process.env.PROFILE_DIR ?? defaultProfileDir,
  navigationTimeoutMs: numFrom("NAVIGATION_TIMEOUT_MS", process.env.NAVIGATION_TIMEOUT_MS, 45000, 1000),
  challengeTimeoutMs: numFrom("CHALLENGE_TIMEOUT_MS", process.env.CHALLENGE_TIMEOUT_MS, 45000, 1000),
  searchCacheTtlS: numFrom("SEARCH_CACHE_TTL_S", process.env.SEARCH_CACHE_TTL_S, 180),
  detailCacheTtlS: numFrom("DETAIL_CACHE_TTL_S", process.env.DETAIL_CACHE_TTL_S, 1800),
  taxonomyCacheTtlS: numFrom("TAXONOMY_CACHE_TTL_S", process.env.TAXONOMY_CACHE_TTL_S, 86400),
  maxBatch: numFrom("MAX_BATCH", process.env.MAX_BATCH, 10, 1),
  blockAssets: boolFrom(process.env.BLOCK_ASSETS, false),
  debug: boolFrom(process.env.DEBUG, false),
};
