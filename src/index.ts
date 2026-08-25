#!/usr/bin/env node
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TtlCache } from "./cache.js";
import { config } from "./config.js";
import { Fetcher } from "./fetcher.js";
import { buildSearchUrl, parseSearchResults, resolveSort } from "./parsers/search.js";
import { extractCustomerId, extractDealerId, parseDetail, type WatchDetail } from "./parsers/detail.js";
import {
  brandSlugFromUrl,
  filterBrands,
  parseBrands,
  parseFacets,
  parseModels,
  resolveBrand,
  type Facet,
} from "./parsers/taxonomy.js";
import { parseRatings } from "./parsers/ratings.js";
import { computeStats } from "./parsers/stats.js";
import {
  findModelsInput,
  getDealerListingsInput,
  getDealerRatingsInput,
  getWatchesInput,
  getWatchInput,
  getPriceStatsInput,
  listBrandsInput,
  listFiltersInput,
  searchInput,
} from "./tools/schemas.js";

const require = createRequire(import.meta.url);
const VERSION: string = require("../package.json").version;

const INSTRUCTIONS = [
  "Tools for the Chrono24 watch marketplace (search + listing details).",
  "Requests run through a real browser and are deliberately slow (~3.5s spacing) to avoid blocking; expect several seconds per uncached call.",
  "Prices are normalized to USD.",
  "Workflow: search_listings first, then get_watch or get_watches on a shortlist of ids (batch capped at " +
    config.maxBatch +
    ").",
  "Empty result sets are valid outcomes, not errors.",
  "On Cloudflare errors wait ~30s and retry once; if it persists ask the user to set HEADLESS=false.",
].join(" ");

const server = new McpServer({ name: "chrono24", version: VERSION }, { instructions: INSTRUCTIONS });
const fetcher = new Fetcher();
const cache = new TtlCache();

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
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

function hintFor(err: unknown): string | undefined {
  const msg = err instanceof Error ? err.message : String(err);
  if (/cloudflare|challenge/i.test(msg)) {
    return "Upstream is rate-limiting or challenging us. Wait ~30s and retry once. If it persists, the user can restart with HEADLESS=false to complete the challenge interactively.";
  }
  if (/navigation failed/i.test(msg)) {
    return "Network error reaching Chrono24. Check connectivity and retry.";
  }
  return undefined;
}

async function cachedFetch(url: string, ttlS: number) {
  const hit = cache.get<{ status: number; html: string; finalUrl: string }>(url);
  if (hit) return hit;
  const fresh = await fetcher.fetch(url);
  cache.set(url, fresh, ttlS);
  return fresh;
}

server.tool(
  "search_listings",
  "Search Chrono24 watch listings. Returns up to 60 cards per page with id, url, title, USD price, location, seller type and thumbnail - enough to shortlist without fetching details.",
  searchInput,
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
      const res = await cachedFetch(url, config.searchCacheTtlS);
      const parsed = parseSearchResults(res.html, res.finalUrl, args.page ?? 1);
      const listings = args.limit ? parsed.listings.slice(0, args.limit) : parsed.listings;
      return ok({ ...parsed, listings, count: listings.length });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err), hintFor(err));
    }
  },
);

server.tool(
  "get_watch",
  "Get full details for one Chrono24 listing by id: reference, specs (movement, case, caliber), box/papers, dealer info, all photos and the canonical URL.",
  getWatchInput,
  async (args) => {
    try {
      const url = `${config.baseUrl}/watches/--id${args.id}.htm`;
      const res = await cachedFetch(url, config.detailCacheTtlS);
      const detail: WatchDetail = {
        id: args.id,
        canonicalUrl: res.finalUrl,
        ...parseDetail(res.html),
      };
      const customerId = extractCustomerId(res.html);
      const dealerId = extractDealerId(res.html);
      return ok({
        ...detail,
        sellerIds: customerId || dealerId ? { customerId, dealerId } : undefined,
      });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err), hintFor(err));
    }
  },
);

server.tool(
  "get_watches",
  `Get full details for a shortlist of up to ${config.maxBatch} Chrono24 listing ids. Runs politely and sequentially; uncached ids take ~4s each.`,
  getWatchesInput,
  async (args) => {
    const results: Array<WatchDetail & { error?: string }> = [];
    try {
      for (const id of args.ids) {
        try {
          const url = `${config.baseUrl}/watches/--id${id}.htm`;
          const res = await cachedFetch(url, config.detailCacheTtlS);
          results.push({ id, canonicalUrl: res.finalUrl, ...parseDetail(res.html) });
        } catch (err) {
          results.push({
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
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return ok({
        count: results.length,
        watches: results,
        note: "Per-id errors appear in the watch entry's error field; other entries remain valid.",
      });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err), hintFor(err));
    }
  },
);

const BROAD_SEARCH_URL = `${config.baseUrl}/search/index.htm?dosearch=true&sortorder=5&pageSize=60&currencyId=${config.currencyId}`;

async function cachedBrands() {
  const hit = cache.get<ReturnType<typeof parseBrands>>("taxonomy:brands");
  if (hit) return hit;
  const res = await cachedFetch(BROAD_SEARCH_URL, config.taxonomyCacheTtlS);
  const brands = parseBrands(res.html);
  cache.set("taxonomy:brands", brands, config.taxonomyCacheTtlS);
  return brands;
}

server.tool(
  "list_brands",
  "List Chrono24 watch brands with their numeric ids (550+). Use an id with search_listings' manufacturerIds, or a name with find_models.",
  listBrandsInput,
  async (args) => {
    try {
      const brands = await cachedBrands();
      const filtered = args.query ? filterBrands(brands, args.query) : brands;
      return ok({ count: filtered.length, brands: filtered });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err), hintFor(err));
    }
  },
);

server.tool(
  "find_models",
  "List a brand's model catalog (model name, slug and numeric model id). Pair the model id with search_listings' models param and the brand id with manufacturerIds for precise searches.",
  findModelsInput,
  async (args) => {
    try {
      const brands = await cachedBrands();
      const brand = resolveBrand(brands, args.brand);
      if (!brand) {
        return ok({
          count: 0,
          models: [],
          note: `No brand matching "${args.brand}". Call list_brands to see available names.`,
        });
      }
      const cacheKey = `taxonomy:models:${brand.id}`;
      const hit = cache.get<{ brand: typeof brand; slug: string; models: ReturnType<typeof parseModels> }>(
        cacheKey,
      );
      if (hit) return ok({ ...hit, count: hit.models.length });

      const res = await cachedFetch(
        `${config.baseUrl}/search/index.htm?dosearch=true&manufacturerIds=${brand.id}&sortorder=5&pageSize=60&currencyId=${config.currencyId}`,
        config.taxonomyCacheTtlS,
      );
      let slug = brandSlugFromUrl(res.finalUrl);
      let html = res.html;
      if (!slug || !html.includes("--mod")) {
        const brandPage = await cachedFetch(
          `${config.baseUrl}/${slug ?? "watches"}/index.htm`,
          config.taxonomyCacheTtlS,
        );
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
      return fail(err instanceof Error ? err.message : String(err), hintFor(err));
    }
  },
);

server.tool(
  "list_filters",
  "List Chrono24 search facet filters with their allowed values (case material, bracelet material, gender, watch category, country, listing age, ...). Use values with search_listings' facets param.",
  listFiltersInput,
  async (args) => {
    try {
      let facets = cache.get<Facet[]>("taxonomy:facets");
      if (!facets) {
        const res = await cachedFetch(BROAD_SEARCH_URL, config.taxonomyCacheTtlS);
        facets = parseFacets(res.html);
        cache.set("taxonomy:facets", facets, config.taxonomyCacheTtlS);
      }
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
      return fail(err instanceof Error ? err.message : String(err), hintFor(err));
    }
  },
);

server.tool(
  "get_price_stats",
  "Price statistics for a watch across Chrono24: min, percentiles (p10/p25/median/p75/p90), max and sample size, computed from the 60 cheapest matching listings sorted ascending. One polite request.",
  getPriceStatsInput,
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
      const statsKey = `stats:${url}`;
      const hit = cache.get<Record<string, unknown>>(statsKey);
      if (hit) return ok(hit);
      const res = await cachedFetch(url, config.searchCacheTtlS);
      const parsed = parseSearchResults(res.html, res.finalUrl, 1);
      const prices = parsed.listings.map((l) => l.priceValue).filter((p): p is number => p !== null);
      const stats = computeStats(prices);
      const payload = {
        scope: {
          query: args.query ?? null,
          manufacturerIds: args.manufacturerIds ?? null,
          models: args.models ?? null,
        },
        totalCount: parsed.totalCount,
        sourceUrl: parsed.sourceUrl,
        currency: "USD",
        stats,
        cheapest: parsed.listings.filter((l) => l.priceValue !== null).slice(0, 3),
        note: stats
          ? `Stats computed from the ${stats.sampleSize} cheapest listings on page 1 (sorted price ascending).`
          : "No priced listings found for this scope.",
      };
      cache.set(statsKey, payload, config.searchCacheTtlS);
      return ok(payload);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err), hintFor(err));
    }
  },
);

server.tool(
  "get_dealer_listings",
  "List a dealer's current inventory by their customerId (from get_watch's sellerIds). Same card shape as search_listings.",
  getDealerListingsInput,
  async (args) => {
    try {
      const url = buildSearchUrl({
        customerId: args.customerId,
        sortorder: resolveSort(args.sort),
        page: args.page,
        pageSize: 60,
      });
      const res = await cachedFetch(url, config.searchCacheTtlS);
      const parsed = parseSearchResults(res.html, res.finalUrl, args.page ?? 1);
      return ok({ customerId: args.customerId, ...parsed });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err), hintFor(err));
    }
  },
);

server.tool(
  "get_dealer_ratings",
  "Fetch a dealer's customer reviews by their dealerId (from get_watch's sellerIds - NOT the customerId). Includes per-review rating, text, dealer reply and paging totals.",
  getDealerRatingsInput,
  async (args) => {
    try {
      const url = `${config.baseUrl}/api/merchant/ratings.json?dealerId=${args.dealerId}&size=${args.size}&offset=${args.offset}&stars=0&sorting=Relevance`;
      const cacheKey = `ratings:${args.dealerId}:${args.size}:${args.offset}`;
      const hit = cache.get<ReturnType<typeof parseRatings>>(cacheKey);
      if (hit) return ok({ dealerId: args.dealerId, ...hit });
      const res = await fetcher.fetchJson(url);
      if (res.status !== 200) {
        return fail(`Ratings request failed with status ${res.status}`, hintFor(new Error("upstream")));
      }
      const parsed = parseRatings(res.body);
      cache.set(cacheKey, parsed, config.searchCacheTtlS);
      return ok({ dealerId: args.dealerId, ...parsed });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err), hintFor(err));
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
