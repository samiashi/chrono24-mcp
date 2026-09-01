#!/usr/bin/env node
import path from "node:path";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { TtlCache } from "./cache.js";
import { diskRead, diskWrite } from "./diskStore.js";
import { config } from "./config.js";
import { Fetcher, type FetchResult } from "./fetcher.js";
import {
  buildPagedUrl,
  buildSearchUrl,
  detectCurrency,
  parseSearchResults,
  partitionFacets,
  resolveSort,
  FACET_PARAM_ALLOWLIST,
  FACET_USE_INSTEAD,
  type SearchOptions,
  type SearchResult,
} from "./parsers/search.js";
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
  normalizeText,
  parseBrands,
  parseFacets,
  parseModels,
  resolveBrand,
  type Brand,
  type Facet,
} from "./parsers/taxonomy.js";
import { parseModelGuide } from "./parsers/guide.js";
import { parseRatings } from "./parsers/ratings.js";
import { computeStats, estimateStats, type RankedPrice } from "./parsers/stats.js";
import { z } from "zod";
import {
  checkSavedSearchesInput,
  checkSavedSearchesOutput,
  checkWatchedListingsInput,
  checkWatchedListingsOutput,
  getModelGuideInput,
  getModelGuideOutput,
  getWatchPhotosInput,
  getWatchPhotosOutput,
  healthCheckInput,
  healthCheckOutput,
  unwatchListingInput,
  unwatchListingOutput,
  watchListingInput,
  watchListingOutput,
  deleteSavedSearchInput,
  deleteSavedSearchOutput,
  findDealsInput,
  findDealsOutput,
  listSavedSearchesInput,
  listSavedSearchesOutput,
  saveSearchInput,
  saveSearchOutput,
  searchAllInput,
  searchAllOutput,
  serverStatusInput,
  serverStatusOutput,
  valueCollectionInput,
  valueCollectionOutput,
  findModelsInput,
  findModelsOutput,
  getDealerListingsInput,
  getDealerListingsOutput,
  getDealerRatingsInput,
  getDealerRatingsOutput,
  getDealerRatingSummaryInput,
  getDealerRatingSummaryOutput,
  getDealerRatingSummariesInput,
  getDealerRatingSummariesOutput,
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
  "Tools for the Chrono24 watch marketplace: search, listing details and photos, dealer vetting, price analytics, buying guides, and persistent trackers.",
  "Requests run through a real browser and are deliberately slow (~3.5s spacing) to avoid blocking; expect several seconds per uncached call. Long calls emit progress notifications.",
  "Prices are pinned to the configured currency (default USD).",
  "Shortcuts for common questions: 'good deal on X' -> find_deals; 'fair price for X' -> get_price_stats (sample:'spread' for full-range); 'about the X model / which ref' -> get_model_guide; 'trust this seller?' -> get_dealer_rating_summary; 'alert me about new/changed listings' -> save_search / watch_listing.",
  "General workflow: search_listings, then get_watch or get_watches (batch capped at " +
    config.maxBatch +
    ") on a shortlist; get_watch_photos to visually inspect condition.",
  "Free-text queries match fuzzily - resolve precise ids with find_models (or pass referenceNumber) when the exact variant matters.",
  "Empty result sets are valid outcomes, not errors. A not-found error on get_watch means the listing was sold or removed.",
  "The first request of a session may take 60-120s if a Cloudflare challenge must clear; on challenge errors wait ~30s and retry once, and if it persists ask the user to set HEADLESS=false.",
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

// compact JSON: the text block is what LLM clients read - pretty-printing
// adds ~25% pure-whitespace tokens on 60-card search payloads
const ok = (data: object): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: data as Record<string, unknown>,
});

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

// lets clients with resetTimeoutOnProgress survive long calls (batches,
// rating summaries, challenged cold starts); silently a no-op when the
// client did not request progress
function reportProgress(extra: ToolExtra, progress: number, total: number | undefined, message: string) {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return;
  void extra
    .sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress, ...(total !== undefined ? { total } : {}), message },
    })
    .catch(() => {});
}

// heartbeat for the Cloudflare challenge wait inside a fetch - keeps clients
// with resetTimeoutOnProgress alive through 45-135s clearance cycles
function challengeHeartbeat(extra?: ToolExtra): ((message: string) => void) | undefined {
  if (!extra) return undefined;
  let beats = 0;
  return (message) => reportProgress(extra, ++beats, undefined, message);
}

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
    return "The page no longer exists upstream - the id may be wrong, or the listing/dealer/brand page was removed. Search again for current results.";
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

async function fetchOk(url: string, extra?: ToolExtra): Promise<FetchResult> {
  const res = await fetcher.fetch(url, challengeHeartbeat(extra));
  if (res.status >= 400) {
    throw new Error(`Upstream returned HTTP ${res.status} for ${url}`);
  }
  return res;
}

// Cache parsed payloads, never raw HTML: hits skip re-parsing and the cache
// holds kilobytes instead of megabyte page snapshots. Throwing parsers
// (e.g. not-found detection) keep failures out of the cache. Concurrent
// identical misses share one in-flight fetch instead of paying twice.
const inflight = new Map<string, Promise<unknown>>();
const cacheStats = { hits: 0, misses: 0 };
async function cachedParse<T>(
  key: string,
  ttlS: number,
  url: string,
  parse: (res: FetchResult) => T,
  extra?: ToolExtra,
): Promise<T> {
  const hit = cache.get<T>(key);
  if (hit !== undefined) {
    cacheStats.hits++;
    return hit;
  }
  const pending = inflight.get(key);
  if (pending) {
    cacheStats.hits++;
    return pending as Promise<T>;
  }
  cacheStats.misses++;
  const job = (async () => {
    const value = parse(await fetchOk(url, extra));
    cache.set(key, value, ttlS);
    return value;
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

function pageMeta(parsed: SearchResult): { totalPages: number | null; hasMore: boolean | null } {
  const totalPages = parsed.totalCount !== null ? Math.max(1, Math.ceil(parsed.totalCount / 60)) : null;
  return { totalPages, hasMore: totalPages !== null ? parsed.page < totalPages : null };
}

// truthful per-response currency: derived from the prices themselves since
// Chrono24 assigns currency by geolocation and ignores the currencyId param
const currencyOf = (parsed: SearchResult) =>
  detectCurrency(parsed.listings.map((l) => l.priceDisplay)) ?? config.currencyId;

// Page 1 goes through /search/index.htm (which may redirect to a canonical
// brand/model page); deeper pages must be requested at that canonical URL
// with the lowercase showpage param, or Chrono24 silently serves page 1.
async function pagedSearch(opts: SearchOptions, page: number, extra?: ToolExtra): Promise<SearchResult> {
  const page1Url = buildSearchUrl(opts);
  const first = await cachedParse(
    `search:${page1Url}`,
    config.searchCacheTtlS,
    page1Url,
    (res) => parseSearchResults(res.html, res.finalUrl, 1),
    extra,
  );
  if (page <= 1) return first;
  // don't hit upstream for pages that cannot exist - out-of-range showpage
  // requests look bot-like and have triggered Cloudflare challenges
  const { totalPages } = pageMeta(first);
  if (totalPages !== null && page > totalPages) {
    return { totalCount: first.totalCount, count: 0, page, listings: [], sourceUrl: first.sourceUrl };
  }
  if (extra) reportProgress(extra, 1, 2, `resolved canonical page, fetching page ${page}`);
  const pageUrl = buildPagedUrl(first.sourceUrl, page1Url, page);
  return cachedParse(
    `search:${pageUrl}`,
    config.searchCacheTtlS,
    pageUrl,
    (res) => parseSearchResults(res.html, res.finalUrl, page),
    extra,
  );
}

type PriceScope = {
  query?: string;
  manufacturerIds?: string;
  models?: string;
  referenceNumber?: string;
  priceFrom?: number;
  priceTo?: number;
  condition?: "new" | "used";
  year?: number;
  countries?: string[];
  facets?: Record<string, string>;
};

function priceScopeOpts(scope: PriceScope, appliedFacets: Record<string, string>): SearchOptions {
  return {
    query: scope.query || undefined,
    manufacturerIds: scope.manufacturerIds,
    models: scope.models,
    referenceNumber: scope.referenceNumber,
    priceFrom: scope.priceFrom,
    priceTo: scope.priceTo,
    usedOrNew: scope.condition,
    year: scope.year,
    countryIds: scope.countries,
    facets: appliedFacets,
    sortorder: resolveSort("price_asc"),
    pageSize: 60,
  };
}

// Sample first + middle + last price-ascending pages so quantiles can be
// interpolated across the full price range instead of the cheapest tail.
async function spreadSample(
  opts: SearchOptions,
  first: SearchResult,
  extra?: ToolExtra,
): Promise<{ samples: RankedPrice[]; pagesSampled: number[] }> {
  const totalPages = pageMeta(first).totalPages ?? 1;
  const middle = Math.max(2, Math.round((1 + totalPages) / 2));
  const wanted = [...new Set([middle, totalPages])].filter((p) => p > 1 && p <= totalPages);
  const pages: Array<{ page: number; res: SearchResult }> = [{ page: 1, res: first }];
  for (const [i, p] of wanted.entries()) {
    if (extra) reportProgress(extra, i + 1, wanted.length + 1, `sampling price page ${p}/${totalPages}`);
    pages.push({ page: p, res: await pagedSearch(opts, p) });
  }
  const samples: RankedPrice[] = [];
  for (const { page, res } of pages) {
    res.listings.forEach((l, i) => {
      if (l.priceValue !== null) samples.push({ rank: (page - 1) * 60 + i + 1, price: l.priceValue });
    });
  }
  return { samples, pagesSampled: pages.map((p) => p.page) };
}

function parseRatingsSafe(body: string): ReturnType<typeof parseRatings> | null {
  try {
    return parseRatings(body);
  } catch {
    return null;
  }
}

const failNonJsonRatings = () =>
  fail(
    "Ratings endpoint returned non-JSON (likely a Cloudflare challenge page served with status 200)",
    "Wait ~30s and retry once. If it persists, the user can restart with HEADLESS=false to complete the challenge interactively.",
  );

const IGNORED_FACETS_NOTE = (ignored: string[]) =>
  `Ignored facet keys: ${ignored
    .map((k) => (FACET_USE_INSTEAD[k] ? `${k} (use the '${FACET_USE_INSTEAD[k]}' param instead)` : k))
    .join(", ")}. Only allowlisted facets pass through - see list_filters.`;

server.registerTool(
  "search_listings",
  {
    title: "Search Chrono24 listings",
    description:
      "Search Chrono24 watch listings. Returns up to 60 cards per page with id, url, title, price, location, seller type and thumbnail - enough to shortlist without fetching details. Free-text queries match fuzzily; for a precise model scope pass manufacturerIds + models (from find_models) or referenceNumber.",
    inputSchema: searchInput,
    outputSchema: searchOutput,
    annotations: READ_ONLY,
  },
  async (args, extra) => {
    try {
      const { applied, ignored } = partitionFacets(args.facets);
      const parsed = await pagedSearch(
        {
          query: args.query || undefined,
          manufacturerIds: args.manufacturerIds,
          models: args.models,
          referenceNumber: args.referenceNumber,
          priceFrom: args.priceFrom,
          priceTo: args.priceTo,
          usedOrNew: args.condition,
          year: args.year,
          countryIds: args.countries,
          facets: applied,
          sortorder: resolveSort(args.sort),
          certified: args.certified,
        },
        args.page ?? 1,
        extra,
      );
      const listings = args.limit ? parsed.listings.slice(0, args.limit) : parsed.listings;
      const meta = pageMeta(parsed);
      const notes: string[] = [];
      if (ignored.length) notes.push(IGNORED_FACETS_NOTE(ignored));
      if (meta.totalPages !== null && parsed.page > meta.totalPages) {
        notes.push(`Page ${parsed.page} is beyond the last page (${meta.totalPages}); empty page returned.`);
      }
      return ok({
        ...parsed,
        ...meta,
        currency: currencyOf(parsed),
        listings,
        count: listings.length,
        ...(ignored.length ? { ignoredFacets: ignored } : {}),
        ...(notes.length ? { note: notes.join(" ") } : {}),
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

const fetchWatch = (id: string, extra?: ToolExtra): Promise<WatchPayload> =>
  cachedParse(
    `detail:${id}`,
    config.detailCacheTtlS,
    `${config.baseUrl}/watches/--id${id}.htm`,
    parseWatch(id),
    extra,
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
  async (args, extra) => {
    try {
      return ok(await fetchWatch(args.id, extra));
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
  availability: "",
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
  async (args, extra) => {
    try {
      const ids = [...new Set(args.ids)];
      const results: Array<WatchPayload & { error?: string }> = [];
      for (const [i, id] of ids.entries()) {
        try {
          results.push(await fetchWatch(id, extra));
        } catch (err) {
          results.push(emptyDetail(id, err instanceof Error ? err.message : String(err)));
        }
        reportProgress(extra, i + 1, ids.length, `fetched listing ${id}`);
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

// these live inside the profile dir so custom PROFILE_DIR setups don't write
// to an unexpected parent directory; Chrome ignores unknown files in its
// user-data-dir
const TAXONOMY_DISK = path.join(config.profileDir, "chrono24-taxonomy.json");
const MODELS_DISK = path.join(config.profileDir, "chrono24-models.json");

async function cachedBroadTaxonomy(): Promise<BroadTaxonomy> {
  const hit = cache.get<BroadTaxonomy>("taxonomy:broad");
  if (hit) return hit;
  const disk = diskRead<BroadTaxonomy>(TAXONOMY_DISK, "broad", config.taxonomyCacheTtlS);
  if (
    disk &&
    Array.isArray(disk.value.brands) &&
    disk.value.brands.length >= 100 &&
    Array.isArray(disk.value.facets)
  ) {
    cache.set("taxonomy:broad", disk.value, disk.remainingS);
    return disk.value;
  }
  const res = await fetchOk(BROAD_SEARCH_URL);
  const value = { brands: parseBrands(res.html), facets: parseFacets(res.html) };
  cache.set("taxonomy:broad", value, config.taxonomyCacheTtlS);
  diskWrite(TAXONOMY_DISK, "broad", value, config.taxonomyCacheTtlS);
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

type ModelsPayload = {
  brand: Brand & { slug: string };
  slug: string;
  models: ReturnType<typeof parseModels>;
};

// memory -> disk -> live fetch of a brand's model catalog; shared by
// find_models and get_model_guide
async function loadModels(brand: Brand): Promise<ModelsPayload | null> {
  const cacheKey = `taxonomy:models:${brand.id}`;
  const hit = cache.get<ModelsPayload>(cacheKey);
  if (hit) return hit;
  const disk = diskRead<ModelsPayload>(MODELS_DISK, brand.id, config.taxonomyCacheTtlS);
  if (disk && Array.isArray(disk.value.models) && disk.value.models.length > 0 && disk.value.slug) {
    cache.set(cacheKey, disk.value, disk.remainingS);
    return disk.value;
  }
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
  if (!slug) return null;
  const models = parseModels(html, slug, brand.name);
  const payload = { brand: { ...brand, slug }, slug, models };
  cache.set(cacheKey, payload, config.taxonomyCacheTtlS);
  if (models.length > 0) diskWrite(MODELS_DISK, brand.id, payload, config.taxonomyCacheTtlS);
  return payload;
}

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
      const payload = await loadModels(brand);
      if (!payload) {
        return fail(`Could not resolve brand page for "${args.brand}"`);
      }
      return ok({ ...payload, count: payload.models.length });
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
      const annotate = (name: string) => ({
        passthrough: FACET_PARAM_ALLOWLIST.has(name),
        ...(FACET_USE_INSTEAD[name] ? { useInstead: FACET_USE_INSTEAD[name] } : {}),
      });
      if (args.name) {
        const match = facets.find((f) => f.name === args.name);
        if (!match) {
          return ok({
            count: 0,
            note: `No facet named "${args.name}". Available: ${facets.map((f) => f.name).join(", ")}`,
          });
        }
        return ok({
          count: match.options.length,
          name: match.name,
          options: match.options,
          ...annotate(match.name),
        });
      }
      return ok({
        count: facets.length,
        facets: facets.map((f) => ({ ...f, ...annotate(f.name) })),
        note: "Facets with passthrough=false are not accepted by search_listings' facets param; where useInstead is set, pass that dedicated tool param instead.",
      });
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
      "Price statistics for a watch across Chrono24: min, percentiles (p10/p25/median/p75/p90), max and sample size. Default 'cheapest' mode is one polite request (lower-tail biased when >60 match); sample:'spread' adds up to 2 requests and interpolates percentiles across the full price range.",
    inputSchema: getPriceStatsInput,
    outputSchema: getPriceStatsOutput,
    annotations: READ_ONLY,
  },
  async (args, extra) => {
    try {
      const { applied, ignored } = partitionFacets(args.facets);
      const opts = priceScopeOpts(args, applied);
      const parsed = await pagedSearch(opts, 1);
      const prices = parsed.listings.map((l) => l.priceValue).filter((p): p is number => p !== null);
      const wantSpread =
        args.sample === "spread" && parsed.totalCount !== null && parsed.totalCount > prices.length;
      let stats;
      let coverage: "full" | "cheapest-60" | "spread-sampled" | null;
      let pagesSampled: number[] | undefined;
      if (wantSpread) {
        const spread = await spreadSample(opts, parsed, extra);
        stats = estimateStats(spread.samples, parsed.totalCount ?? spread.samples.length);
        coverage = stats ? "spread-sampled" : null;
        pagesSampled = spread.pagesSampled;
      } else {
        stats = computeStats(prices);
        coverage = stats
          ? parsed.totalCount !== null && parsed.totalCount <= stats.sampleSize
            ? "full"
            : "cheapest-60"
          : null;
      }
      return ok({
        scope: {
          query: args.query ?? null,
          manufacturerIds: args.manufacturerIds ?? null,
          models: args.models ?? null,
        },
        totalCount: parsed.totalCount,
        sourceUrl: parsed.sourceUrl,
        currency: currencyOf(parsed),
        coverage,
        ...(pagesSampled ? { pagesSampled } : {}),
        stats,
        cheapest: parsed.listings.filter((l) => l.priceValue !== null).slice(0, 3),
        ...(ignored.length ? { ignoredFacets: ignored } : {}),
        note: [
          stats
            ? coverage === "full"
              ? `Stats cover all ${stats.sampleSize} matching priced listings.`
              : coverage === "spread-sampled"
                ? `Percentiles interpolated from ${stats.sampleSize} listings sampled across pages ${pagesSampled?.join(", ")} of the price-sorted results.`
                : `Stats computed from the ${stats.sampleSize} cheapest listings on page 1 (sorted price ascending); upper percentiles are lower-tail biased. Pass sample:'spread' for full-range estimates.`
            : "No priced listings found for this scope.",
          ...(ignored.length ? [IGNORED_FACETS_NOTE(ignored)] : []),
        ].join(" "),
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
  async (args, extra) => {
    try {
      const parsed = await pagedSearch(
        {
          customerId: args.customerId,
          sortorder: resolveSort(args.sort),
          pageSize: 60,
        },
        args.page ?? 1,
        extra,
      );
      const meta = pageMeta(parsed);
      return ok({
        customerId: args.customerId,
        ...parsed,
        ...meta,
        currency: currencyOf(parsed),
        ...(meta.totalPages !== null && parsed.page > meta.totalPages
          ? { note: `Page ${parsed.page} is beyond the last page (${meta.totalPages}); empty page returned.` }
          : {}),
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
      const parsed = parseRatingsSafe(res.body);
      if (!parsed) return failNonJsonRatings();
      cache.set(cacheKey, parsed, config.searchCacheTtlS);
      return ok({ dealerId: args.dealerId, ...parsed });
    } catch (err) {
      return failFrom(err);
    }
  },
);

interface RatingSummary {
  dealerId: string;
  total: number;
  average: number | null;
  histogram: Record<string, number>;
}

async function computeDealerSummary(
  dealerId: string,
  onStar?: (done: number) => void,
): Promise<RatingSummary> {
  const cacheKey = `ratingsummary:${dealerId}`;
  const hit = cache.get<RatingSummary>(cacheKey);
  if (hit) return hit;
  const histogram: Record<string, number> = {};
  for (const [i, stars] of [5, 4, 3, 2, 1].entries()) {
    const res = await fetcher.fetchJson(
      `${config.baseUrl}/api/merchant/ratings.json?dealerId=${dealerId}&size=1&offset=0&stars=${stars}&sorting=Relevance`,
    );
    if (res.status !== 200) {
      throw new Error(`Ratings request failed with HTTP ${res.status}`);
    }
    const parsed = parseRatingsSafe(res.body);
    if (!parsed) {
      throw new Error(
        "Ratings endpoint returned non-JSON (likely a Cloudflare challenge page served with status 200)",
      );
    }
    histogram[String(stars)] = parsed.filteredTotal;
    onStar?.(i + 1);
  }
  const total = Object.values(histogram).reduce((a, b) => a + b, 0);
  const weighted = [5, 4, 3, 2, 1].reduce((sum, st) => sum + st * histogram[String(st)], 0);
  const payload = {
    dealerId,
    total,
    average: total > 0 ? Math.round((weighted / total) * 100) / 100 : null,
    histogram,
  };
  cache.set(cacheKey, payload, config.detailCacheTtlS);
  return payload;
}

server.registerTool(
  "get_dealer_rating_summary",
  {
    title: "Get dealer rating summary",
    description:
      "Star histogram and weighted average rating for a dealer, reconstructed from per-star review counts. 5 lightweight requests (~8s uncached, then cached 30 min) - use it to vet an unfamiliar dealer before recommending a purchase. For several dealers, prefer get_dealer_rating_summaries.",
    inputSchema: getDealerRatingSummaryInput,
    outputSchema: getDealerRatingSummaryOutput,
    annotations: READ_ONLY,
  },
  async (args, extra) => {
    try {
      return ok(
        await computeDealerSummary(args.dealerId, (done) =>
          reportProgress(extra, done, 5, `counted star bucket ${done}/5`),
        ),
      );
    } catch (err) {
      return failFrom(err);
    }
  },
);

server.registerTool(
  "get_dealer_rating_summaries",
  {
    title: "Get dealer rating summaries (batch)",
    description:
      "Star histograms and average ratings for up to 5 dealers in one call (~8s per uncached dealer, cached 30 min). Vet all shortlisted sellers at once; per-dealer failures don't break the batch.",
    inputSchema: getDealerRatingSummariesInput,
    outputSchema: getDealerRatingSummariesOutput,
    annotations: READ_ONLY,
  },
  async (args, extra) => {
    try {
      const ids = [...new Set(args.dealerIds)];
      const summaries = [];
      for (const [i, dealerId] of ids.entries()) {
        try {
          const s = await computeDealerSummary(dealerId);
          summaries.push({ dealerId, total: s.total, average: s.average, histogram: s.histogram });
        } catch (err) {
          summaries.push({
            dealerId,
            total: null,
            average: null,
            histogram: null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        reportProgress(extra, i + 1, ids.length, `vetted dealer ${dealerId}`);
      }
      return ok({
        count: summaries.length,
        summaries,
        note: "Per-dealer errors appear in the entry's error field; other entries remain valid.",
      });
    } catch (err) {
      return failFrom(err);
    }
  },
);

server.registerTool(
  "find_deals",
  {
    title: "Find deals",
    description:
      "Find listings priced below market for a watch scope: computes full-range price stats (up to 3 polite requests), then returns the cheapest listings at or below the market p25 with their percentage below median. The one-call answer to 'find me a good deal on X'. Free-text scopes match fuzzily (a 'Black Bay 58 GMT' query can match plain Black Bay 58s) - prefer manufacturerIds + models or referenceNumber for precision.",
    inputSchema: findDealsInput,
    outputSchema: findDealsOutput,
    annotations: READ_ONLY,
  },
  async (args, extra) => {
    try {
      const { applied, ignored } = partitionFacets(args.facets);
      const opts = priceScopeOpts(args, applied);
      const first = await pagedSearch(opts, 1);
      const page1Prices = first.listings.map((l) => l.priceValue).filter((p): p is number => p !== null);
      let stats;
      let coverage: "full" | "cheapest-60" | "spread-sampled" | null = null;
      if (first.totalCount !== null && first.totalCount > page1Prices.length) {
        const spread = await spreadSample(opts, first, extra);
        stats = estimateStats(spread.samples, first.totalCount);
        coverage = stats ? "spread-sampled" : null;
      } else {
        stats = computeStats(page1Prices);
        coverage = stats ? "full" : null;
      }
      if (!stats) {
        return ok({
          totalCount: first.totalCount,
          currency: currencyOf(first),
          coverage,
          stats: null,
          deals: [],
          ...(ignored.length ? { ignoredFacets: ignored } : {}),
          sourceUrl: first.sourceUrl,
          note: "No priced listings found for this scope.",
        });
      }
      const deals = first.listings
        .filter((l) => l.priceValue !== null && l.priceValue <= stats.p25)
        .slice(0, args.maxResults)
        .map((l) => {
          const pctBelowMedian = Math.round((1 - l.priceValue! / stats.median) * 100);
          return {
            ...l,
            pctBelowMedian,
            ...(pctBelowMedian >= 60
              ? {
                  caution:
                    "Far below market - verify condition, authenticity and that it is a complete watch (not parts/accessories) before trusting this price.",
                }
              : {}),
          };
        });
      return ok({
        totalCount: first.totalCount,
        currency: currencyOf(first),
        coverage,
        stats,
        deals,
        ...(ignored.length ? { ignoredFacets: ignored } : {}),
        sourceUrl: first.sourceUrl,
        note: `${deals.length} listing(s) at or below the market p25 (${stats.p25} ${config.currencyId}); median is ${stats.median}. Vet the seller (get_dealer_rating_summary) before recommending a purchase. Cross-border purchases may add import duty/VAT not included in listed prices.${ignored.length ? " " + IGNORED_FACETS_NOTE(ignored) : ""}`,
      });
    } catch (err) {
      return failFrom(err);
    }
  },
);

server.registerTool(
  "search_all",
  {
    title: "Search all pages",
    description:
      "Aggregate multiple result pages into one deduplicated list (60 listings per page, one polite ~4s request per uncached page, capped at 5 pages). Use for exhaustive scans; prefer search_listings for quick looks.",
    inputSchema: searchAllInput,
    outputSchema: searchAllOutput,
    annotations: READ_ONLY,
  },
  async (args, extra) => {
    try {
      const { applied, ignored } = partitionFacets(args.facets);
      const opts: SearchOptions = {
        ...priceScopeOpts(args, applied),
        sortorder: resolveSort(args.sort),
      };
      const first = await pagedSearch(opts, 1);
      const totalPages = pageMeta(first).totalPages ?? 1;
      const limit = Math.min(args.maxPages, totalPages);
      const byId = new Map<string, (typeof first.listings)[number]>();
      const addAll = (res: SearchResult) => {
        for (const l of res.listings) byId.set(l.id ?? `anon-${byId.size}`, l);
      };
      addAll(first);
      for (let p = 2; p <= limit; p++) {
        reportProgress(extra, p, limit, `fetching page ${p}/${limit}`);
        const res = await pagedSearch(opts, p);
        if (res.count === 0) break;
        addAll(res);
      }
      const listings = [...byId.values()];
      return ok({
        totalCount: first.totalCount,
        pagesFetched: limit,
        truncated: totalPages > limit,
        count: listings.length,
        currency: currencyOf(first),
        listings,
        ...(ignored.length ? { ignoredFacets: ignored, note: IGNORED_FACETS_NOTE(ignored) } : {}),
        sourceUrl: first.sourceUrl,
      });
    } catch (err) {
      return failFrom(err);
    }
  },
);

server.registerTool(
  "value_collection",
  {
    title: "Value a collection",
    description:
      "Appraise up to 10 watches in one call: per-item market price stats (one polite request each) plus portfolio totals (sum of medians/p25/p75). Give each item a reference number or query, optionally condition/year.",
    inputSchema: valueCollectionInput,
    outputSchema: valueCollectionOutput,
    annotations: READ_ONLY,
  },
  async (args, extra) => {
    try {
      const entries = [];
      let detected: string | null = null;
      for (const [i, item] of args.items.entries()) {
        const label =
          item.label ??
          [item.query, item.referenceNumber].filter(Boolean).join(" ").trim() ??
          `item ${i + 1}`;
        if (!item.query && !item.referenceNumber && !item.models && !item.manufacturerIds) {
          entries.push({
            label,
            totalCount: null,
            coverage: null,
            stats: null,
            error: "no search scope given",
          });
          continue;
        }
        try {
          const parsed = await pagedSearch(priceScopeOpts(item, {}), 1);
          detected ??= detectCurrency(parsed.listings.map((l) => l.priceDisplay));
          const prices = parsed.listings.map((l) => l.priceValue).filter((p): p is number => p !== null);
          const stats = computeStats(prices);
          entries.push({
            label,
            totalCount: parsed.totalCount,
            coverage: stats
              ? parsed.totalCount !== null && parsed.totalCount <= stats.sampleSize
                ? ("full" as const)
                : ("cheapest-60" as const)
              : null,
            stats,
          });
        } catch (err) {
          entries.push({
            label,
            totalCount: null,
            coverage: null,
            stats: null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        reportProgress(extra, i + 1, args.items.length, `appraised ${label}`);
      }
      const priced = entries.filter((e) => e.stats);
      const sum = (pick: (s: { median: number; p25: number; p75: number }) => number) =>
        priced.length ? priced.reduce((acc, e) => acc + pick(e.stats!), 0) : null;
      return ok({
        currency: detected ?? config.currencyId,
        items: entries,
        totals: {
          itemsPriced: priced.length,
          sumOfMedians: sum((s) => s.median),
          sumOfP25: sum((s) => s.p25),
          sumOfP75: sum((s) => s.p75),
        },
        note: "Per-item stats use the cheapest-60 sample (lower-tail biased for common models); medians of rare references are more reliable than of plentiful ones.",
      });
    } catch (err) {
      return failFrom(err);
    }
  },
);

// ---- saved searches (persisted across restarts) ----

const SAVED_DISK = path.join(config.profileDir, "chrono24-saved-searches.json");
const FOREVER_S = Number.MAX_SAFE_INTEGER / 1000;
const SEEN_CAP = 600;

interface SavedSearch {
  name: string;
  params: PriceScope;
  note?: string;
  createdAt: string;
  lastCheckedAt: string;
  seenIds: string[];
}

const readSavedSearches = (): Record<string, SavedSearch> =>
  diskRead<Record<string, SavedSearch>>(SAVED_DISK, "all", FOREVER_S)?.value ?? {};
const writeSavedSearches = (all: Record<string, SavedSearch>) => diskWrite(SAVED_DISK, "all", all, FOREVER_S);

const savedSearchOpts = (params: PriceScope): SearchOptions => ({
  ...priceScopeOpts(params, partitionFacets(params.facets).applied),
  sortorder: resolveSort("newest"),
});

server.registerTool(
  "save_search",
  {
    title: "Save a search",
    description:
      "Save a named search scope and seed it with the current listings, so check_saved_searches later reports only NEW listings. Persists across restarts. One polite request to seed.",
    inputSchema: saveSearchInput,
    outputSchema: saveSearchOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (args) => {
    try {
      const parsed = await pagedSearch(savedSearchOpts(args), 1);
      const all = readSavedSearches();
      const replaced = args.name in all;
      const now = new Date().toISOString();
      const seenIds = parsed.listings.map((l) => l.id).filter((id): id is string => id !== null);
      all[args.name] = {
        name: args.name,
        params: {
          query: args.query,
          manufacturerIds: args.manufacturerIds,
          models: args.models,
          referenceNumber: args.referenceNumber,
          priceFrom: args.priceFrom,
          priceTo: args.priceTo,
          condition: args.condition,
          year: args.year,
          countries: args.countries,
          facets: args.facets,
        },
        ...(args.note ? { note: args.note } : {}),
        createdAt: replaced ? all[args.name].createdAt : now,
        lastCheckedAt: now,
        seenIds,
      };
      writeSavedSearches(all);
      return ok({
        name: args.name,
        totalCount: parsed.totalCount,
        seeded: seenIds.length,
        replaced,
        note: `Saved. Run check_saved_searches${args.name ? ` (name: "${args.name}")` : ""} later - only listings newer than this snapshot will be reported.`,
      });
    } catch (err) {
      return failFrom(err);
    }
  },
);

server.registerTool(
  "list_saved_searches",
  {
    title: "List saved searches",
    description: "List all saved searches with their scopes and last-checked times. No network requests.",
    inputSchema: listSavedSearchesInput,
    outputSchema: listSavedSearchesOutput,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    try {
      const all = Object.values(readSavedSearches());
      return ok({
        count: all.length,
        searches: all.map((s) => ({
          name: s.name,
          params: Object.fromEntries(Object.entries(s.params).filter(([, v]) => v !== undefined)),
          ...(s.note ? { note: s.note } : {}),
          createdAt: s.createdAt,
          lastCheckedAt: s.lastCheckedAt,
          seenCount: s.seenIds.length,
        })),
      });
    } catch (err) {
      return failFrom(err);
    }
  },
);

server.registerTool(
  "check_saved_searches",
  {
    title: "Check saved searches",
    description:
      "Re-run saved searches and report only listings that appeared since the last check. One polite request per search - ideal for a scheduled agent. Pass name to check a single search.",
    inputSchema: checkSavedSearchesInput,
    outputSchema: checkSavedSearchesOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (args, extra) => {
    try {
      const all = readSavedSearches();
      const targets = args.name ? (all[args.name] ? [all[args.name]] : []) : Object.values(all);
      if (args.name && targets.length === 0) {
        return fail(`No saved search named "${args.name}"`, "Call list_saved_searches to see what exists.");
      }
      const results = [];
      for (const [i, saved] of targets.entries()) {
        const previousCheckAt = saved.lastCheckedAt;
        try {
          const parsed = await pagedSearch(savedSearchOpts(saved.params), 1);
          const seen = new Set(saved.seenIds);
          const fresh = parsed.listings.filter((l) => l.id !== null && !seen.has(l.id));
          const currentIds = parsed.listings.map((l) => l.id).filter((id): id is string => id !== null);
          saved.seenIds = [...new Set([...currentIds, ...saved.seenIds])].slice(0, SEEN_CAP);
          saved.lastCheckedAt = new Date().toISOString();
          results.push({
            name: saved.name,
            totalCount: parsed.totalCount,
            newCount: fresh.length,
            newListings: fresh.slice(0, 20),
            previousCheckAt,
          });
        } catch (err) {
          results.push({
            name: saved.name,
            totalCount: null,
            newCount: 0,
            newListings: [],
            previousCheckAt,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        reportProgress(extra, i + 1, targets.length, `checked "${saved.name}"`);
      }
      writeSavedSearches(all);
      return ok({
        checked: results.length,
        results,
        note: results.length
          ? "newListings contains only listings never seen by a previous check of that search."
          : "No saved searches yet - create one with save_search.",
      });
    } catch (err) {
      return failFrom(err);
    }
  },
);

server.registerTool(
  "delete_saved_search",
  {
    title: "Delete a saved search",
    description: "Remove a saved search by name. No network requests.",
    inputSchema: deleteSavedSearchInput,
    outputSchema: deleteSavedSearchOutput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async (args) => {
    try {
      const all = readSavedSearches();
      const existed = args.name in all;
      if (existed) {
        delete all[args.name];
        writeSavedSearches(all);
      }
      return ok({
        deleted: existed,
        name: args.name,
        ...(existed ? {} : { note: "No saved search by that name existed." }),
      });
    } catch (err) {
      return failFrom(err);
    }
  },
);

server.registerTool(
  "server_status",
  {
    title: "Server status",
    description:
      "Diagnostics: browser state, cache and disk-cache freshness, politeness settings. No network requests - useful when calls feel slow or stuck.",
    inputSchema: serverStatusInput,
    outputSchema: serverStatusOutput,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    try {
      return ok({
        version: VERSION,
        uptimeS: Math.round(process.uptime()),
        browser: { ...fetcher.status(), headless: config.headless },
        telemetry: { ...fetcher.telemetry(), cacheHits: cacheStats.hits, cacheMisses: cacheStats.misses },
        cacheEntries: cache.size,
        taxonomyDiskFresh: diskRead(TAXONOMY_DISK, "broad", config.taxonomyCacheTtlS) !== null,
        savedSearches: Object.keys(readSavedSearches()).length,
        requestDelayMs: config.requestDelayMs,
        baseUrl: config.baseUrl,
        currency: config.currencyId,
      });
    } catch (err) {
      return failFrom(err);
    }
  },
);

server.registerTool(
  "get_model_guide",
  {
    title: "Get model buying guide",
    description:
      "Chrono24's editorial buying guide for a model: history, 'how much does it cost', investment notes and the per-reference approximate price table (e.g. Submariner 6538 'James Bond' ~148,000 USD). One polite request, cached 24h.",
    inputSchema: getModelGuideInput,
    outputSchema: getModelGuideOutput,
    annotations: READ_ONLY,
  },
  async (args) => {
    try {
      const { brands } = await cachedBroadTaxonomy();
      const brand = resolveBrand(brands, args.brand);
      if (!brand) {
        return fail(`No brand matching "${args.brand}"`, "Call list_brands to see available names.");
      }
      const payload = await loadModels(brand);
      if (!payload) return fail(`Could not resolve brand page for "${args.brand}"`);
      const wanted = normalizeText(args.model);
      const model =
        payload.models.find((m) => m.modelId === args.model.trim()) ??
        payload.models.find((m) => m.slug === wanted) ??
        payload.models.find((m) => normalizeText(m.name) === wanted) ??
        payload.models.find((m) => normalizeText(m.name).includes(wanted));
      if (!model) {
        return fail(
          `No model matching "${args.model}" for ${payload.brand.name}`,
          `Call find_models(brand: "${payload.brand.name}") to see the catalog.`,
        );
      }
      const url = `${config.baseUrl}/${payload.slug}/${model.slug}--mod${model.modelId}.htm`;
      const guide = await cachedParse(
        `guide:${payload.slug}:${model.modelId}`,
        config.taxonomyCacheTtlS,
        url,
        (res) => parseModelGuide(res.html),
      );
      return ok({
        brand: payload.brand,
        model,
        url,
        sections: guide.sections,
        referencePrices: guide.referencePrices,
        ...(guide.referencePrices.length === 0
          ? { note: "No reference price table on this model page; sections may still carry price guidance." }
          : {
              note: "referencePrices are Chrono24's editorial approximations - cross-check with get_price_stats for live market numbers.",
            }),
      });
    } catch (err) {
      return failFrom(err);
    }
  },
);

server.registerTool(
  "get_watch_photos",
  {
    title: "Get listing photos",
    description:
      "Fetch a listing's photos as inline images so their condition and authenticity cues can be inspected visually. Large ~28KB each. Fast CDN fetches (no politeness delay needed).",
    inputSchema: getWatchPhotosInput,
    outputSchema: getWatchPhotosOutput,
    annotations: READ_ONLY,
  },
  async (args, extra) => {
    try {
      const detail = await fetchWatch(args.id);
      if (detail.images.length === 0) {
        return ok({
          id: args.id,
          requested: args.maxPhotos,
          returned: 0,
          photos: [],
          note: "Listing has no photos.",
        });
      }
      const photos: Array<{ url: string; mimeType: string; bytes: number }> = [];
      const imageBlocks: Array<{ type: "image"; data: string; mimeType: string }> = [];
      for (const [i, original] of detail.images.slice(0, args.maxPhotos).entries()) {
        const url = original.replace(
          /-(ExtraLarge|Large|Medium|Small)\.(jpg|jpeg|png|webp)$/i,
          `-${args.size}.$2`,
        );
        const res = await fetcher.fetchBinary(url);
        reportProgress(
          extra,
          i + 1,
          Math.min(args.maxPhotos, detail.images.length),
          `fetched photo ${i + 1}`,
        );
        if (res.status !== 200 || !res.base64) continue;
        const mimeType = res.contentType.split(";")[0] || "image/jpeg";
        photos.push({ url, mimeType, bytes: Math.round((res.base64.length * 3) / 4) });
        imageBlocks.push({ type: "image", data: res.base64, mimeType });
      }
      const meta = {
        id: args.id,
        requested: args.maxPhotos,
        returned: photos.length,
        photos,
        ...(photos.length === 0
          ? { note: "Photo fetches failed - the CDN may have rejected the session." }
          : {}),
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(meta) }, ...imageBlocks],
        structuredContent: meta as Record<string, unknown>,
      };
    } catch (err) {
      return failFrom(err);
    }
  },
);

// ---- watched listings (price-drop / sold tracking) ----

const WATCHED_DISK = path.join(config.profileDir, "chrono24-watched-listings.json");
const WATCHED_CAP = 20;

interface WatchedListing {
  id: string;
  title: string;
  note?: string;
  addedAt: string;
  lastCheckedAt: string;
  lastPriceValue: number | null;
  lastPriceDisplay: string;
  lastStatus: "active" | "gone";
}

const readWatched = (): Record<string, WatchedListing> =>
  diskRead<Record<string, WatchedListing>>(WATCHED_DISK, "all", FOREVER_S)?.value ?? {};
const writeWatched = (all: Record<string, WatchedListing>) => diskWrite(WATCHED_DISK, "all", all, FOREVER_S);

server.registerTool(
  "watch_listing",
  {
    title: "Watch a listing",
    description:
      "Track a specific listing for price changes and sold/removed status; check_watched_listings reports what changed. Persists across restarts. One polite request to seed.",
    inputSchema: watchListingInput,
    outputSchema: watchListingOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (args) => {
    try {
      const all = readWatched();
      if (!(args.id in all) && Object.keys(all).length >= WATCHED_CAP) {
        return fail(
          `Watched-listing cap reached (${WATCHED_CAP})`,
          "Remove one with unwatch_listing before adding another.",
        );
      }
      const detail = await fetchWatch(args.id);
      const now = new Date().toISOString();
      const title = [detail.brand, detail.model].filter(Boolean).join(" ") || `listing ${args.id}`;
      all[args.id] = {
        id: args.id,
        title,
        ...(args.note ? { note: args.note } : {}),
        addedAt: all[args.id]?.addedAt ?? now,
        lastCheckedAt: now,
        lastPriceValue: detail.priceValue,
        lastPriceDisplay: detail.priceDisplay,
        lastStatus: "active",
      };
      writeWatched(all);
      return ok({
        id: args.id,
        title,
        priceDisplay: detail.priceDisplay,
        priceValue: detail.priceValue,
        watchedCount: Object.keys(all).length,
        note: "Run check_watched_listings later to see price changes or sold status.",
      });
    } catch (err) {
      return failFrom(err);
    }
  },
);

server.registerTool(
  "unwatch_listing",
  {
    title: "Unwatch a listing",
    description: "Stop tracking a listing. No network requests.",
    inputSchema: unwatchListingInput,
    outputSchema: unwatchListingOutput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async (args) => {
    try {
      const all = readWatched();
      const removed = args.id in all;
      if (removed) {
        delete all[args.id];
        writeWatched(all);
      }
      return ok({ removed, id: args.id, watchedCount: Object.keys(all).length });
    } catch (err) {
      return failFrom(err);
    }
  },
);

server.registerTool(
  "check_watched_listings",
  {
    title: "Check watched listings",
    description:
      "Re-check every watched listing and report price changes and sold/removed status. One polite request per listing not in the 30-min detail cache - ideal for a scheduled agent.",
    inputSchema: checkWatchedListingsInput,
    outputSchema: checkWatchedListingsOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (_args, extra) => {
    try {
      const all = readWatched();
      const targets = Object.values(all);
      const results = [];
      let changes = 0;
      for (const [i, w] of targets.entries()) {
        const previousPriceValue = w.lastPriceValue;
        try {
          const detail = await fetchWatch(w.id);
          const priceChanged =
            detail.priceValue !== previousPriceValue &&
            !(detail.priceValue === null && previousPriceValue === null);
          const changePct =
            priceChanged && detail.priceValue !== null && previousPriceValue
              ? Math.round(((detail.priceValue - previousPriceValue) / previousPriceValue) * 1000) / 10
              : null;
          if (priceChanged) changes++;
          results.push({
            id: w.id,
            title: w.title,
            status: "active" as const,
            priceValue: detail.priceValue,
            priceDisplay: detail.priceDisplay,
            previousPriceValue,
            priceChanged,
            changePct,
            ...(w.note ? { userNote: w.note } : {}),
          });
          w.lastPriceValue = detail.priceValue;
          w.lastPriceDisplay = detail.priceDisplay;
          w.lastStatus = "active";
        } catch (err) {
          const gone = err instanceof NotFoundError;
          if (gone && w.lastStatus !== "gone") changes++;
          results.push({
            id: w.id,
            title: w.title,
            status: gone ? ("gone" as const) : ("error" as const),
            priceValue: null,
            priceDisplay: "",
            previousPriceValue,
            priceChanged: false,
            changePct: null,
            ...(w.note ? { userNote: w.note } : {}),
            ...(gone ? {} : { error: err instanceof Error ? err.message : String(err) }),
          });
          if (gone) w.lastStatus = "gone";
        }
        w.lastCheckedAt = new Date().toISOString();
        reportProgress(extra, i + 1, targets.length, `checked ${w.title}`);
      }
      writeWatched(all);
      return ok({
        checked: results.length,
        changes,
        results,
        note: results.length
          ? "status 'gone' means the listing was sold or removed. Prices reflect the 30-min detail cache."
          : "No watched listings yet - add one with watch_listing.",
      });
    } catch (err) {
      return failFrom(err);
    }
  },
);

server.registerTool(
  "health_check",
  {
    title: "Health check",
    description:
      "Live canary: two polite requests (one search, one detail) asserting the parsing invariants that matter. Run after Chrono24 markup changes are suspected, or on a schedule.",
    inputSchema: healthCheckInput,
    outputSchema: healthCheckOutput,
    annotations: READ_ONLY,
  },
  async (_args, extra) => {
    const t0 = Date.now();
    const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
    try {
      const url = buildSearchUrl({ query: "Rolex Submariner", sortorder: resolveSort("newest") });
      const res = await fetchOk(url, extra);
      const parsed = parseSearchResults(res.html, res.finalUrl, 1);
      checks.push({
        name: "search-cards",
        pass: parsed.count === 60,
        detail: `${parsed.count}/60 cards parsed`,
      });
      checks.push({
        name: "search-total",
        pass: parsed.totalCount !== null,
        detail: `totalCount=${parsed.totalCount}`,
      });
      const first = parsed.listings.find((l) => l.id && l.priceValue !== null);
      checks.push({
        name: "search-card-fields",
        pass: Boolean(first),
        detail: first ? `id=${first.id} price=${first.priceValue}` : "no card with id and price",
      });
      reportProgress(extra, 1, 2, "search parsed, fetching a detail page");
      if (first?.id) {
        const dres = await fetchOk(`${config.baseUrl}/watches/--id${first.id}.htm`, extra);
        const detail = parseDetail(dres.html);
        checks.push({
          name: "detail-content",
          pass: hasDetailContent(detail),
          detail: `brand="${detail.brand}" images=${detail.images.length} specs=${Object.keys(detail.specs).length}`,
        });
        checks.push({
          name: "detail-core-fields",
          pass: Boolean(detail.brand && detail.priceValue),
          detail: `price=${detail.priceValue} ref="${detail.reference}"`,
        });
      }
    } catch (err) {
      checks.push({ name: "fetch", pass: false, detail: err instanceof Error ? err.message : String(err) });
    }
    const allPass = checks.every((c) => c.pass);
    return ok({
      allPass,
      durationMs: Date.now() - t0,
      checks,
      note: allPass
        ? "All parsing invariants hold."
        : "Failures usually mean Chrono24 changed markup - refresh fixtures (npm run capture-fixtures) and update selectors.",
    });
  },
);

// ---- prompts: guided multi-tool recipes ----

server.registerPrompt(
  "appraise_watch",
  {
    title: "Appraise a watch",
    description: "Estimate fair market value for a watch (reference, model or description)",
    argsSchema: { watch: z.string().describe("Reference number, model name or description") },
  },
  ({ watch }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Appraise this watch on Chrono24: "${watch}".

1. Resolve it: if it looks like a brand/model, use list_brands + find_models to get precise ids; if it is a reference number, use it directly.
2. Call get_price_stats with sample:"spread" for full-range percentiles. If condition or year matter, run it twice (e.g. condition:"used" vs "new") and compare.
3. Sanity-check with find_deals to see what the cheapest credible listings look like.
4. Report: fair range (p25-p75), median, sample size and coverage caveats, and what drives the spread (condition, year, box/papers - spot-check 2-3 listings with get_watch if needed).`,
        },
      },
    ],
  }),
);

server.registerPrompt(
  "vet_dealer",
  {
    title: "Vet a dealer",
    description: "Assess whether a Chrono24 seller is trustworthy before buying",
    argsSchema: {
      listingId: z.string().describe("Listing id (digits from the URL) whose seller should be vetted"),
    },
  },
  ({ listingId }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Vet the seller of Chrono24 listing ${listingId}.

1. get_watch(${listingId}) - note sellerIds (customerId and dealerId) and whether it is a dealer or private seller. Private sellers have no ratings; say so and stop after step 4.
2. get_dealer_rating_summary with the dealerId - overall average and star histogram.
3. get_dealer_ratings with stars:1, size:5 - read the worst reviews for red-flag patterns (non-delivery, authenticity disputes) vs. noise (shipping delays).
4. get_dealer_listings with the customerId - a large, coherent inventory is a good sign.
5. Verdict: trustworthy / caution / avoid, with the evidence.`,
        },
      },
    ],
  }),
);

server.registerPrompt(
  "find_deal",
  {
    title: "Find the best deal",
    description: "Find and vet the best-value listing for a watch, end to end",
    argsSchema: {
      watch: z.string().describe("What to hunt for, e.g. 'Omega Speedmaster Professional'"),
      budget: z.string().optional().describe("Optional max budget, e.g. '5000'"),
    },
  },
  ({ watch, budget }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Find me the best deal on: "${watch}"${budget ? ` with a budget of ${budget}` : ""}.

1. Resolve the model precisely (find_models) so the search is not polluted by other models.
2. find_deals on that scope${budget ? ` with priceTo:${budget}` : ""} - it returns below-market listings with pctBelowMedian and caution flags.
3. get_watches on the top 2-3 candidate ids - check condition, year, box/papers, and that nothing explains the low price.
4. Vet the seller of the best candidate (get_dealer_rating_summary + worst reviews).
5. Recommend one listing with the reasoning, or say why none qualify.`,
        },
      },
    ],
  }),
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
