#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TtlCache } from "./cache.js";
import { config } from "./config.js";
import { Fetcher, type FetchResult } from "./fetcher.js";
import { buildSearchUrl, parseSearchResults, resolveSort, type SearchResult } from "./parsers/search.js";
import {
  extractCustomerId,
  extractDealerId,
  hasDetailContent,
  parseDetail,
  type WatchDetail,
} from "./parsers/detail.js";
import {
  brandSlugFromUrl,
  filterBrands,
  parseBrands,
  parseFacets,
  parseModels,
  resolveBrand,
  type Brand,
  type Facet,
} from "./parsers/taxonomy.js";
import { parseRatings } from "./parsers/ratings.js";
import { computeStats } from "./parsers/stats.js";
import {
  findModelsInput,
  findModelsOutput,
  getDealerListingsInput,
  getDealerListingsOutput,
  getDealerRatingsInput,
  getDealerRatingsOutput,
  getDealerRatingSummaryInput,
  getDealerRatingSummaryOutput,
  getWatchesInput,
  getWatchesOutput,
  getWatchInput,
  getWatchOutput,
  getPriceStatsInput,
  getPriceStatsOutput,
  listBrandsInput,
  listBrandsOutput,
  listFiltersInput,
  listFiltersOutput,
  searchInput,
  searchOutput,
} from "./tools/schemas.js";

const require = createRequire(import.meta.url);
const VERSION: string = require("../package.json").version;

const INSTRUCTIONS = [
  "Tools for the Chrono24 watch marketplace (search + listing details).",
  "Requests run through a real browser and are deliberately slow (~3.5s spacing) to avoid blocking; expect several seconds per uncached call.",
  "Prices are pinned to the configured currency (default USD).",
  "Workflow: search_listings first, then get_watch or get_watches on a shortlist of ids (batch capped at " +
    config.maxBatch +
    ").",
  "Empty result sets are valid outcomes, not errors. A not-found error on get_watch means the listing was sold or removed.",
  "On Cloudflare errors wait ~30s and retry once; if it persists ask the user to set HEADLESS=false.",
].join(" ");

const server = new McpServer({ name: "chrono24", version: VERSION }, { instructions: INSTRUCTIONS });
const fetcher = new Fetcher();
const cache = new TtlCache();

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const ok = (data: object): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  structuredContent: data as Record<string, unknown>,
});

const fail = (message: string, hint?: string): ToolResult => ({
  isError: true,
  content: [
    {
      type: "text",
      text: hint ? `Error: ${message}\n\nHint: ${hint}` : `Error: ${message}`,
    },
  ],
});

class NotFoundError extends Error {}

function hintFor(err: unknown): string | undefined {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof NotFoundError || /HTTP 404/.test(msg)) {
    return "The page no longer exists upstream - the listing/dealer was likely sold or removed. Run search_listings again for current results.";
  }
  if (/HTTP (403|429)/.test(msg) || /cloudflare|challenge/i.test(msg)) {
    return "Upstream is rate-limiting or challenging us. Wait ~30s and retry once. If it persists, the user can restart with HEADLESS=false to complete the challenge interactively.";
  }
  if (/navigation failed/i.test(msg)) {
    return "Network error reaching Chrono24. Check connectivity and retry.";
  }
  return undefined;
}

const failFrom = (err: unknown): ToolResult =>
  fail(err instanceof Error ? err.message : String(err), hintFor(err));

async function fetchOk(url: string): Promise<FetchResult> {
  const res = await fetcher.fetch(url);
  if (res.status >= 400) {
    throw new Error(`Upstream returned HTTP ${res.status} for ${url}`);
  }
  return res;
}

// Cache parsed payloads, never raw HTML: hits skip re-parsing and the cache
// holds kilobytes instead of megabyte page snapshots. Throwing parsers
// (e.g. not-found detection) keep failures out of the cache.
async function cachedParse<T>(
  key: string,
  ttlS: number,
  url: string,
  parse: (res: FetchResult) => T,
): Promise<T> {
  const hit = cache.get<T>(key);
  if (hit !== undefined) return hit;
  const value = parse(await fetchOk(url));
  cache.set(key, value, ttlS);
  return value;
}

function pageMeta(parsed: SearchResult): { totalPages: number | null; hasMore: boolean | null } {
  const totalPages = parsed.totalCount !== null ? Math.max(1, Math.ceil(parsed.totalCount / 60)) : null;
  return { totalPages, hasMore: totalPages !== null ? parsed.page < totalPages : null };
}

server.registerTool(
  "search_listings",
  {
    title: "Search Chrono24 listings",
    description:
      "Search Chrono24 watch listings. Returns up to 60 cards per page with id, url, title, price, location, seller type and thumbnail - enough to shortlist without fetching details.",
    inputSchema: searchInput,
    outputSchema: searchOutput,
    annotations: READ_ONLY,
  },
  async (args) => {
    try {
      const url = buildSearchUrl({
        query: args.query || undefined,
        manufacturerIds: args.manufacturerIds,
        models: args.models,
        referenceNumber: args.referenceNumber,
        priceFrom: args.priceFrom,
        priceTo: args.priceTo,
        usedOrNew: args.condition,
        year: args.year,
        countryIds: args.countries,
        facets: args.facets,
        sortorder: resolveSort(args.sort),
        page: args.page,
        certified: args.certified,
      });
      const parsed = await cachedParse(`search:${url}`, config.searchCacheTtlS, url, (res) =>
        parseSearchResults(res.html, res.finalUrl, args.page ?? 1),
      );
      const listings = args.limit ? parsed.listings.slice(0, args.limit) : parsed.listings;
      return ok({
        ...parsed,
        ...pageMeta(parsed),
        currency: config.currencyId,
        listings,
        count: listings.length,
      });
    } catch (err) {
      return failFrom(err);
    }
  },
);

type WatchPayload = WatchDetail & {
  sellerIds?: { customerId: string | null; dealerId: string | null };
};

function parseWatch(id: string): (res: FetchResult) => WatchPayload {
  return (res) => {
    const detail = parseDetail(res.html);
    const idInUrl = new RegExp(`--id${id}\\.htm`).test(res.finalUrl);
    if (!idInUrl || !hasDetailContent(detail)) {
      throw new NotFoundError(`Listing ${id} not found or removed (sold listings disappear)`);
    }
    const customerId = extractCustomerId(res.html);
    const dealerId = extractDealerId(res.html);
    return {
      id,
      canonicalUrl: res.finalUrl,
      ...detail,
      sellerIds: customerId || dealerId ? { customerId, dealerId } : undefined,
    };
  };
}

const fetchWatch = (id: string): Promise<WatchPayload> =>
  cachedParse(
    `detail:${id}`,
    config.detailCacheTtlS,
    `${config.baseUrl}/watches/--id${id}.htm`,
    parseWatch(id),
  );

server.registerTool(
  "get_watch",
  {
    title: "Get watch details",
    description:
      "Get full details for one Chrono24 listing by id: reference, specs (movement, case, caliber), box/papers, dealer info, all photos and the canonical URL.",
    inputSchema: getWatchInput,
    outputSchema: getWatchOutput,
    annotations: READ_ONLY,
  },
  async (args) => {
    try {
      return ok(await fetchWatch(args.id));
    } catch (err) {
      return failFrom(err);
    }
  },
);

const emptyDetail = (id: string, error: string): WatchDetail & { error: string } => ({
  id,
  brand: "",
  model: "",
  reference: "",
  priceDisplay: "",
  priceValue: null,
  currency: "",
  condition: "",
  year: "",
  movement: "",
  caseMaterial: "",
  caseDiameter: "",
  gender: "",
  scope: "",
  description: "",
  location: "",
  images: [],
  specs: {},
  error,
});

server.registerTool(
  "get_watches",
  {
    title: "Get watch details (batch)",
    description: `Get full details for a shortlist of up to ${config.maxBatch} Chrono24 listing ids. Runs politely and sequentially; uncached ids take ~4s each.`,
    inputSchema: getWatchesInput,
    outputSchema: getWatchesOutput,
    annotations: READ_ONLY,
  },
  async (args) => {
    try {
      const ids = [...new Set(args.ids)];
      const results: Array<WatchPayload & { error?: string }> = [];
      for (const id of ids) {
        try {
          results.push(await fetchWatch(id));
        } catch (err) {
          results.push(emptyDetail(id, err instanceof Error ? err.message : String(err)));
        }
      }
      return ok({
        count: results.length,
        watches: results,
        note: "Per-id errors appear in the watch entry's error field; other entries remain valid.",
      });
    } catch (err) {
      return failFrom(err);
    }
  },
);

const BROAD_SEARCH_URL = `${config.baseUrl}/search/index.htm?dosearch=true&sortorder=5&pageSize=60&currencyId=${config.currencyId}`;

interface BroadTaxonomy {
  brands: Brand[];
  facets: Facet[];
}

const TAXONOMY_DISK = path.join(config.profileDir, "..", "taxonomy.json");

function readTaxonomyDisk(): (BroadTaxonomy & { remainingS: number }) | null {
  try {
    const raw = JSON.parse(fs.readFileSync(TAXONOMY_DISK, "utf8")) as {
      fetchedAt?: unknown;
      brands?: unknown;
      facets?: unknown;
    };
    const ageS = (Date.now() - Number(raw.fetchedAt)) / 1000;
    if (!Number.isFinite(ageS) || ageS < 0 || ageS >= config.taxonomyCacheTtlS) return null;
    if (!Array.isArray(raw.brands) || raw.brands.length < 100 || !Array.isArray(raw.facets)) return null;
    return {
      brands: raw.brands as Brand[],
      facets: raw.facets as Facet[],
      remainingS: config.taxonomyCacheTtlS - ageS,
    };
  } catch {
    return null;
  }
}

function writeTaxonomyDisk(value: BroadTaxonomy) {
  try {
    fs.mkdirSync(path.dirname(TAXONOMY_DISK), { recursive: true });
    fs.writeFileSync(TAXONOMY_DISK, JSON.stringify({ fetchedAt: Date.now(), ...value }));
  } catch (err) {
    console.error(`[taxonomy] disk cache write failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function cachedBroadTaxonomy(): Promise<BroadTaxonomy> {
  const hit = cache.get<BroadTaxonomy>("taxonomy:broad");
  if (hit) return hit;
  const disk = readTaxonomyDisk();
  if (disk) {
    const value = { brands: disk.brands, facets: disk.facets };
    cache.set("taxonomy:broad", value, disk.remainingS);
    return value;
  }
  const res = await fetchOk(BROAD_SEARCH_URL);
  const value = { brands: parseBrands(res.html), facets: parseFacets(res.html) };
  cache.set("taxonomy:broad", value, config.taxonomyCacheTtlS);
  writeTaxonomyDisk(value);
  return value;
}

server.registerTool(
  "list_brands",
  {
    title: "List watch brands",
    description:
      "List Chrono24 watch brands with their numeric ids (550+). Use an id with search_listings' manufacturerIds, or a name with find_models.",
    inputSchema: listBrandsInput,
    outputSchema: listBrandsOutput,
    annotations: READ_ONLY,
  },
  async (args) => {
    try {
      const { brands } = await cachedBroadTaxonomy();
      const filtered = args.query ? filterBrands(brands, args.query) : brands;
      return ok({ count: filtered.length, brands: filtered });
    } catch (err) {
      return failFrom(err);
    }
  },
);

server.registerTool(
  "find_models",
  {
    title: "Find brand models",
    description:
      "List a brand's model catalog (model name, slug and numeric model id). Pair the model id with search_listings' models param and the brand id with manufacturerIds for precise searches.",
    inputSchema: findModelsInput,
    outputSchema: findModelsOutput,
    annotations: READ_ONLY,
  },
  async (args) => {
    try {
      const { brands } = await cachedBroadTaxonomy();
      const brand = resolveBrand(brands, args.brand);
      if (!brand) {
        return ok({
          count: 0,
          models: [],
          note: `No brand matching "${args.brand}". Call list_brands to see available names.`,
        });
      }
      const cacheKey = `taxonomy:models:${brand.id}`;
      const hit = cache.get<{
        brand: Brand & { slug: string };
        slug: string;
        models: ReturnType<typeof parseModels>;
      }>(cacheKey);
      if (hit) return ok({ ...hit, count: hit.models.length });

      const res = await fetchOk(
        `${config.baseUrl}/search/index.htm?dosearch=true&manufacturerIds=${brand.id}&sortorder=5&pageSize=60&currencyId=${config.currencyId}`,
      );
      let slug = brandSlugFromUrl(res.finalUrl);
      let html = res.html;
      if (!slug || !html.includes("--mod")) {
        const brandPage = await fetchOk(`${config.baseUrl}/${slug ?? "watches"}/index.htm`);
        slug = slug ?? brandSlugFromUrl(brandPage.finalUrl);
        html = brandPage.html.includes("--mod") ? brandPage.html : html;
      }
      if (!slug) {
        return fail(`Could not resolve brand page for "${args.brand}"`);
      }
      const models = parseModels(html, slug, brand.name);
      const payload = { brand: { ...brand, slug }, slug, models };
      cache.set(cacheKey, payload, config.taxonomyCacheTtlS);
      return ok({ ...payload, count: models.length });
    } catch (err) {
      return failFrom(err);
    }
  },
);

server.registerTool(
  "list_filters",
  {
    title: "List search filters",
    description:
      "List Chrono24 search facet filters with their allowed values (case material, bracelet material, gender, watch category, country, listing age, ...). Use values with search_listings' facets param.",
    inputSchema: listFiltersInput,
    outputSchema: listFiltersOutput,
    annotations: READ_ONLY,
  },
  async (args) => {
    try {
      const { facets } = await cachedBroadTaxonomy();
      if (args.name) {
        const match = facets.find((f) => f.name === args.name);
        if (!match) {
          return ok({
            count: 0,
            note: `No facet named "${args.name}". Available: ${facets.map((f) => f.name).join(", ")}`,
          });
        }
        return ok({ count: match.options.length, name: match.name, options: match.options });
      }
      return ok({ count: facets.length, facets });
    } catch (err) {
      return failFrom(err);
    }
  },
);

server.registerTool(
  "get_price_stats",
  {
    title: "Get price statistics",
    description:
      "Price statistics for a watch across Chrono24: min, percentiles (p10/p25/median/p75/p90), max and sample size, computed from the 60 cheapest matching listings sorted ascending. One polite request.",
    inputSchema: getPriceStatsInput,
    outputSchema: getPriceStatsOutput,
    annotations: READ_ONLY,
  },
  async (args) => {
    try {
      const url = buildSearchUrl({
        query: args.query,
        manufacturerIds: args.manufacturerIds,
        models: args.models,
        referenceNumber: args.referenceNumber,
        priceFrom: args.priceFrom,
        priceTo: args.priceTo,
        usedOrNew: args.condition,
        year: args.year,
        countryIds: args.countries,
        facets: args.facets,
        sortorder: resolveSort("price_asc"),
        pageSize: 60,
      });
      const parsed = await cachedParse(`search:${url}`, config.searchCacheTtlS, url, (res) =>
        parseSearchResults(res.html, res.finalUrl, 1),
      );
      const prices = parsed.listings.map((l) => l.priceValue).filter((p): p is number => p !== null);
      const stats = computeStats(prices);
      const coverage = stats
        ? parsed.totalCount !== null && parsed.totalCount <= stats.sampleSize
          ? ("full" as const)
          : ("cheapest-60" as const)
        : null;
      return ok({
        scope: {
          query: args.query ?? null,
          manufacturerIds: args.manufacturerIds ?? null,
          models: args.models ?? null,
        },
        totalCount: parsed.totalCount,
        sourceUrl: parsed.sourceUrl,
        currency: config.currencyId,
        coverage,
        stats,
        cheapest: parsed.listings.filter((l) => l.priceValue !== null).slice(0, 3),
        note: stats
          ? coverage === "full"
            ? `Stats cover all ${stats.sampleSize} matching priced listings.`
            : `Stats computed from the ${stats.sampleSize} cheapest listings on page 1 (sorted price ascending); upper percentiles are lower-tail biased.`
          : "No priced listings found for this scope.",
      });
    } catch (err) {
      return failFrom(err);
    }
  },
);

server.registerTool(
  "get_dealer_listings",
  {
    title: "Get dealer inventory",
    description:
      "List a dealer's current inventory by their customerId (from get_watch's sellerIds). Same card shape as search_listings.",
    inputSchema: getDealerListingsInput,
    outputSchema: getDealerListingsOutput,
    annotations: READ_ONLY,
  },
  async (args) => {
    try {
      const url = buildSearchUrl({
        customerId: args.customerId,
        sortorder: resolveSort(args.sort),
        page: args.page,
        pageSize: 60,
      });
      const parsed = await cachedParse(`search:${url}`, config.searchCacheTtlS, url, (res) =>
        parseSearchResults(res.html, res.finalUrl, args.page ?? 1),
      );
      return ok({
        customerId: args.customerId,
        ...parsed,
        ...pageMeta(parsed),
        currency: config.currencyId,
      });
    } catch (err) {
      return failFrom(err);
    }
  },
);

server.registerTool(
  "get_dealer_ratings",
  {
    title: "Get dealer ratings",
    description:
      "Fetch a dealer's customer reviews by their dealerId (from get_watch's sellerIds - NOT the customerId). Includes per-review rating, text, dealer reply and paging totals; filter with stars (1-5).",
    inputSchema: getDealerRatingsInput,
    outputSchema: getDealerRatingsOutput,
    annotations: READ_ONLY,
  },
  async (args) => {
    try {
      const stars = args.stars ?? 0;
      // sorting is pinned to Relevance - the API 400s on every other value (probed live)
      const url = `${config.baseUrl}/api/merchant/ratings.json?dealerId=${args.dealerId}&size=${args.size}&offset=${args.offset}&stars=${stars}&sorting=Relevance`;
      const cacheKey = `ratings:${args.dealerId}:${args.size}:${args.offset}:${stars}`;
      const hit = cache.get<ReturnType<typeof parseRatings>>(cacheKey);
      if (hit) return ok({ dealerId: args.dealerId, ...hit });
      const res = await fetcher.fetchJson(url);
      if (res.status !== 200) {
        return fail(
          `Ratings request failed with HTTP ${res.status}`,
          hintFor(new Error(`HTTP ${res.status}`)),
        );
      }
      const parsed = parseRatings(res.body);
      cache.set(cacheKey, parsed, config.searchCacheTtlS);
      return ok({ dealerId: args.dealerId, ...parsed });
    } catch (err) {
      return failFrom(err);
    }
  },
);

server.registerTool(
  "get_dealer_rating_summary",
  {
    title: "Get dealer rating summary",
    description:
      "Star histogram and weighted average rating for a dealer, reconstructed from per-star review counts. Costs 5 polite requests (~20s uncached, then cached 30 min) - use it to vet an unfamiliar dealer before recommending a purchase.",
    inputSchema: getDealerRatingSummaryInput,
    outputSchema: getDealerRatingSummaryOutput,
    annotations: READ_ONLY,
  },
  async (args) => {
    try {
      const cacheKey = `ratingsummary:${args.dealerId}`;
      const hit = cache.get<Record<string, unknown>>(cacheKey);
      if (hit) return ok(hit);
      const histogram: Record<string, number> = {};
      for (const stars of [5, 4, 3, 2, 1]) {
        const res = await fetcher.fetchJson(
          `${config.baseUrl}/api/merchant/ratings.json?dealerId=${args.dealerId}&size=1&offset=0&stars=${stars}&sorting=Relevance`,
        );
        if (res.status !== 200) {
          return fail(
            `Ratings request failed with HTTP ${res.status}`,
            hintFor(new Error(`HTTP ${res.status}`)),
          );
        }
        histogram[String(stars)] = parseRatings(res.body).filteredTotal;
      }
      const total = Object.values(histogram).reduce((a, b) => a + b, 0);
      const weighted = [5, 4, 3, 2, 1].reduce((sum, s) => sum + s * histogram[String(s)], 0);
      const payload = {
        dealerId: args.dealerId,
        total,
        average: total > 0 ? Math.round((weighted / total) * 100) / 100 : null,
        histogram,
      };
      cache.set(cacheKey, payload, config.detailCacheTtlS);
      return ok(payload);
    } catch (err) {
      return failFrom(err);
    }
  },
);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await fetcher.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// when the MCP client goes away, stdio closes - exit instead of leaving an orphaned browser
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`chrono24-mcp v${VERSION} running on stdio`);
}

main().catch(async (err) => {
  console.error("chrono24-mcp fatal:", err instanceof Error ? err.message : err);
  await fetcher.close();
  process.exit(1);
});
