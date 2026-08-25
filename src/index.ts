#!/usr/bin/env node
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
  parseModels,
  resolveBrand,
} from "./parsers/taxonomy.js";
import {
  findModelsInput,
  getWatchesInput,
  getWatchInput,
  listBrandsInput,
  searchInput,
} from "./tools/schemas.js";

const VERSION = "0.1.0";

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
