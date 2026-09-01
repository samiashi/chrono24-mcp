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
function reportProgress(extra: ToolExtra, progress: number, total: number, message: string) {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return;
  void extra
    .sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress, total, message },
    })
    .catch(() => {});
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

async function fetchOk(url: string): Promise<FetchResult> {
  const res = await fetcher.fetch(url);
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
async function cachedParse<T>(
  key: string,
  ttlS: number,
  url: string,
  parse: (res: FetchResult) => T,
): Promise<T> {
  const hit = cache.get<T>(key);
  if (hit !== undefined) return hit;
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const job = (async () => {
    const value = parse(await fetchOk(url));
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

// Page 1 goes through /search/index.htm (which may redirect to a canonical
// brand/model page); deeper pages must be requested at that canonical URL
// with the lowercase showpage param, or Chrono24 silently serves page 1.
async function pagedSearch(opts: SearchOptions, page: number, extra?: ToolExtra): Promise<SearchResult> {
  const page1Url = buildSearchUrl(opts);
  const first = await cachedParse(`search:${page1Url}`, config.searchCacheTtlS, page1Url, (res) =>
    parseSearchResults(res.html, res.finalUrl, 1),
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
  return cachedParse(`search:${pageUrl}`, config.searchCacheTtlS, pageUrl, (res) =>
    parseSearchResults(res.html, res.finalUrl, page),
  );
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
      "Search Chrono24 watch listings. Returns up to 60 cards per page with id, url, title, price, location, seller type and thumbnail - enough to shortlist without fetching details.",
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
        currency: config.currencyId,
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
  async (args, extra) => {
    try {
      const ids = [...new Set(args.ids)];
      const results: Array<WatchPayload & { error?: string }> = [];
      for (const [i, id] of ids.entries()) {
        try {
          results.push(await fetchWatch(id));
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
      type ModelsPayload = {
        brand: Brand & { slug: string };
        slug: string;
        models: ReturnType<typeof parseModels>;
      };
      const cacheKey = `taxonomy:models:${brand.id}`;
      const hit = cache.get<ModelsPayload>(cacheKey);
      if (hit) return ok({ ...hit, count: hit.models.length });
      const disk = diskRead<ModelsPayload>(MODELS_DISK, brand.id, config.taxonomyCacheTtlS);
      if (disk && Array.isArray(disk.value.models) && disk.value.models.length > 0 && disk.value.slug) {
        cache.set(cacheKey, disk.value, disk.remainingS);
        return ok({ ...disk.value, count: disk.value.models.length });
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
      if (!slug) {
        return fail(`Could not resolve brand page for "${args.brand}"`);
      }
      const models = parseModels(html, slug, brand.name);
      const payload = { brand: { ...brand, slug }, slug, models };
      cache.set(cacheKey, payload, config.taxonomyCacheTtlS);
      if (models.length > 0) diskWrite(MODELS_DISK, brand.id, payload, config.taxonomyCacheTtlS);
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
      "Price statistics for a watch across Chrono24: min, percentiles (p10/p25/median/p75/p90), max and sample size, computed from the 60 cheapest matching listings sorted ascending. One polite request.",
    inputSchema: getPriceStatsInput,
    outputSchema: getPriceStatsOutput,
    annotations: READ_ONLY,
  },
  async (args) => {
    try {
      const { applied, ignored } = partitionFacets(args.facets);
      const parsed = await pagedSearch(
        {
          query: args.query,
          manufacturerIds: args.manufacturerIds,
          models: args.models,
          referenceNumber: args.referenceNumber,
          priceFrom: args.priceFrom,
          priceTo: args.priceTo,
          usedOrNew: args.condition,
          year: args.year,
          countryIds: args.countries,
          facets: applied,
          sortorder: resolveSort("price_asc"),
          pageSize: 60,
        },
        1,
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
        ...(ignored.length ? { ignoredFacets: ignored } : {}),
        note: [
          stats
            ? coverage === "full"
              ? `Stats cover all ${stats.sampleSize} matching priced listings.`
              : `Stats computed from the ${stats.sampleSize} cheapest listings on page 1 (sorted price ascending); upper percentiles are lower-tail biased.`
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
        currency: config.currencyId,
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
  async (args, extra) => {
    try {
      const cacheKey = `ratingsummary:${args.dealerId}`;
      const hit = cache.get<Record<string, unknown>>(cacheKey);
      if (hit) return ok(hit);
      const histogram: Record<string, number> = {};
      for (const [i, stars] of [5, 4, 3, 2, 1].entries()) {
        const res = await fetcher.fetchJson(
          `${config.baseUrl}/api/merchant/ratings.json?dealerId=${args.dealerId}&size=1&offset=0&stars=${stars}&sorting=Relevance`,
        );
        if (res.status !== 200) {
          return fail(
            `Ratings request failed with HTTP ${res.status}`,
            hintFor(new Error(`HTTP ${res.status}`)),
          );
        }
        const parsed = parseRatingsSafe(res.body);
        if (!parsed) return failNonJsonRatings();
        histogram[String(stars)] = parsed.filteredTotal;
        reportProgress(extra, i + 1, 5, `counted ${stars}-star reviews`);
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
