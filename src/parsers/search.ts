import { load, type CheerioAPI } from "cheerio";
import { config } from "../config.js";
import { warnDrift } from "./taxonomy.js";

export interface SearchOptions {
  query?: string;
  manufacturerIds?: string;
  models?: string;
  referenceNumber?: string;
  priceFrom?: number;
  priceTo?: number;
  usedOrNew?: string;
  year?: number;
  countryIds?: string[];
  sortorder?: string;
  pageSize?: number;
  certified?: boolean;
  customerId?: string;
  facets?: Record<string, string>;
  currencyId?: string;
}

export const FACET_PARAM_ALLOWLIST = new Set([
  "caseMaterials",
  "braceletMaterial",
  "claspMaterial",
  "clasp",
  "dialColors",
  "dialNumbers",
  "movementTypes",
  "functions",
  "otherAttributes",
  "condition",
  "specials",
  "styles",
  "gender",
  "watchCategories",
  "maxAgeInDays",
  "stockInfo",
  "bezelMaterial",
  "crystal",
  "waterproof",
]);

export interface ListingCard {
  id: string | null;
  url: string;
  brandModel: string;
  detail: string;
  priceDisplay: string | null;
  priceValue: number | null;
  negotiable: boolean;
  location: string | null;
  sellerType: "dealer" | "private" | null;
  badge: string | null;
  imageUrl: string | null;
}

export interface SearchResult {
  totalCount: number | null;
  count: number;
  page: number;
  listings: ListingCard[];
  sourceUrl: string;
}

const SORT_MAP: Record<string, string> = {
  relevance: "0",
  price_asc: "1",
  newest: "5",
  price_desc: "11",
  popularity: "15",
};

export function resolveSort(sort?: string): string {
  return SORT_MAP[sort ?? "newest"] ?? SORT_MAP.newest;
}

// Facet keys that are select-based filters on the site but map to dedicated
// tool params instead of facet passthrough.
export const FACET_USE_INSTEAD: Record<string, string> = {
  countryIds: "countries",
  usedOrNew: "condition",
};

export function partitionFacets(facets?: Record<string, string>): {
  applied: Record<string, string>;
  ignored: string[];
} {
  const applied: Record<string, string> = {};
  const ignored: string[] = [];
  for (const [key, value] of Object.entries(facets ?? {})) {
    if (FACET_PARAM_ALLOWLIST.has(key) && value) applied[key] = value;
    else ignored.push(key);
  }
  return { applied, ignored };
}

export function buildSearchUrl(opts: SearchOptions): string {
  const qs = new URLSearchParams();
  qs.set("dosearch", "true");
  const put = (k: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  };
  // there is no working referenceNumber URL param (alone it renders an empty
  // page, with a query it is dropped in the redirect) - the free-text search
  // matches references well, so fold it into the query instead
  put("query", [opts.query, opts.referenceNumber].filter(Boolean).join(" "));
  put("manufacturerIds", opts.manufacturerIds);
  put("models", opts.models);
  put("priceFrom", opts.priceFrom);
  put("priceTo", opts.priceTo);
  put("usedOrNew", opts.usedOrNew);
  put("year", opts.year);
  for (const c of opts.countryIds ?? []) qs.append("countryIds", c);
  put("sortorder", opts.sortorder ?? "5");
  put("pageSize", opts.pageSize ?? 60);
  put("customerId", opts.customerId);
  if (opts.certified) qs.set("certified", "true");
  for (const [key, value] of Object.entries(opts.facets ?? {})) {
    if (FACET_PARAM_ALLOWLIST.has(key) && value) qs.set(key, value);
  }
  qs.set("currencyId", opts.currencyId ?? config.currencyId);
  return `${config.baseUrl}/search/index.htm?${qs.toString()}`;
}

// Paging only works on the canonical (post-redirect) page: /search/index.htm
// strips paging params during its redirect to brand/model pages, and the
// param is the lowercase "showpage" - Chrono24 ignores "showPage".
export function buildPagedUrl(canonicalUrl: string, page1RequestUrl: string, page: number): string {
  const canonical = new URL(canonicalUrl);
  const params = new URL(page1RequestUrl).searchParams;
  params.set("showpage", String(page));
  return `${canonical.origin}${canonical.pathname}?${params.toString()}`;
}

const PRICE_VALUE_RE = /[\d.,]+/;

// Chrono24 assigns the session currency by geolocation and ignores the
// currencyId URL param (probed live 2026-09 with fresh profiles) - so the
// truthful currency comes from the prices themselves. Multi-char symbols
// must match before the bare "$".
const CURRENCY_HINTS: Array<[RegExp, string]> = [
  [/\bAED\b/, "AED"],
  [/\bCHF\b/, "CHF"],
  [/HK\$|\bHKD\b/, "HKD"],
  [/C\$|\bCAD\b/, "CAD"],
  [/A\$|\bAUD\b/, "AUD"],
  [/£|\bGBP\b/, "GBP"],
  [/€|\bEUR\b/, "EUR"],
  [/¥|\bJPY\b/, "JPY"],
  [/\bSGD\b/, "SGD"],
  [/\$|\bUSD\b/, "USD"],
];

// Attribute words in free-text queries match listing titles poorly (a
// "women gold watch" query returns zero results even though both are
// facets) - map them to the params/facets that actually filter.
const QUERY_ATTRIBUTE_HINTS: Array<[RegExp, string]> = [
  [/\b(women'?s?|woman|ladies'?|lady|female)\b/i, "use facets.gender (values via list_filters)"],
  [/\b(men'?s?|man\b|male|gents?)\b/i, "use facets.gender (values via list_filters)"],
  [
    /\b(gold|steel|titanium|platinum|ceramic|bronze|carbon)\b/i,
    "use facets.caseMaterials (values via list_filters)",
  ],
  [/\b(leather|rubber|nato)\b/i, "use facets.braceletMaterial (values via list_filters)"],
  [/\b(unworn|brand.?new)\b/i, "use the condition param ('new')"],
  [/\b(used|pre-?owned)\b/i, "use the condition param ('used')"],
];

export function zeroResultHints(query?: string): string[] {
  if (!query) return [];
  const hints: string[] = [];
  for (const [re, hint] of QUERY_ATTRIBUTE_HINTS) {
    const m = query.match(re);
    if (m) hints.push(`"${m[0]}" - ${hint}`);
  }
  return hints;
}

export function detectCurrency(displays: Array<string | null | undefined>): string | null {
  for (const display of displays) {
    if (!display) continue;
    for (const [re, code] of CURRENCY_HINTS) {
      if (re.test(display)) return code;
    }
  }
  return null;
}

// Handles both separator conventions: "10,307.50" / "10.307,50" / "1.234.567".
// A lone separator followed by exactly 3 digits is grouping (cards show no cents).
export function parseLocalizedNumber(raw: string): number | null {
  const cleaned = raw.replace(/[^\d.,]/g, "");
  if (!/\d/.test(cleaned)) return null;
  const lastDot = cleaned.lastIndexOf(".");
  const lastComma = cleaned.lastIndexOf(",");
  let decimalSep = "";
  if (lastDot !== -1 && lastComma !== -1) {
    decimalSep = lastDot > lastComma ? "." : ",";
  } else if (lastDot !== -1 || lastComma !== -1) {
    const sep = lastDot !== -1 ? "." : ",";
    const idx = Math.max(lastDot, lastComma);
    const digitsAfter = cleaned.length - idx - 1;
    const occurrences = cleaned.split(sep).length - 1;
    if (occurrences === 1 && digitsAfter >= 1 && digitsAfter <= 2) decimalSep = sep;
  }
  let normalized = "";
  for (const ch of cleaned) {
    if (ch >= "0" && ch <= "9") normalized += ch;
    else if (ch === decimalSep) normalized += ".";
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function parsePrice(display: string): { priceDisplay: string | null; priceValue: number | null } {
  const trimmed = display.trim();
  if (!trimmed || /price on request/i.test(trimmed)) return { priceDisplay: null, priceValue: null };
  const match = trimmed.match(PRICE_VALUE_RE);
  if (!match) return { priceDisplay: trimmed, priceValue: null };
  return { priceDisplay: trimmed, priceValue: parseLocalizedNumber(match[0]) };
}

const COUNT_LABEL_RE = /^\s*([\d.,]+)\s+(results?|watches?|listings?)\b/i;

function parseTotalCount($: CheerioAPI): number | null {
  // the count usually sits in a bare <strong>, so try those before the wider sweep
  for (const el of [...$("strong").toArray(), ...$("span, p").toArray()]) {
    const $el = $(el);
    if ($el.children().length > 0) continue;
    const text = $el.text().trim();
    const m = text.match(COUNT_LABEL_RE);
    if (m) {
      const n = parseLocalizedNumber(m[1]);
      if (n !== null) return Math.round(n);
    }
  }
  return null;
}

function absoluteUrl(href: string): string {
  if (!href) return href;
  return href.startsWith("http") ? href : `${config.baseUrl}${href}`;
}

export function parseSearchResults(html: string, finalUrl: string, page: number): SearchResult {
  const $ = load(html);
  let nodes = $("div.js-listing-item-container").toArray();
  if (nodes.length === 0) nodes = $("a.js-article-item").toArray();
  if (nodes.length === 0 && $("body").text().trim().length > 2000) {
    warnDrift("search", "0 listing cards matched known selectors on a loaded page");
  }

  const listings: ListingCard[] = nodes.map((node) => {
    const $card = $(node);
    const linkEl = $card.find("a.js-listing-item-link").first();
    const href = linkEl.attr("href") ?? $card.attr("href") ?? "";
    const idMatch = href.match(/--id(\d+)\.htm/);
    const p = $card
      .find("p.text-ellipsis")
      .toArray()
      .map((el) => $(el).text().trim());
    const priceRaw =
      $card.find("p.wt-listing-item-price").first().text().trim() ||
      $card.find(".price").first().text().trim();
    const { priceDisplay, priceValue } = parsePrice(priceRaw);
    const locBtn = $card.find("button.wt-listing-item-location").first();
    const location = locBtn.attr("data-title") || locBtn.text().trim() || null;
    const badge =
      $card.find(".wt-listing-item-image-badge, .wt-listing-item-augly-badge").first().text().trim() || null;
    const cardText = $card.text();
    const sellerType = /private seller/i.test(cardText) ? ("private" as const) : ("dealer" as const);
    const img = $card.find("img[data-lazy-sweet-spot-master-src], img.sweetspot").first();
    const imageUrl =
      (img.attr("data-lazy-sweet-spot-master-src") ?? img.attr("src") ?? "").replace("_SIZE_", "280") || null;
    return {
      id: idMatch?.[1] ?? null,
      url: absoluteUrl(href),
      brandModel: p[0] ?? "",
      detail: p[1] ?? "",
      priceDisplay,
      priceValue,
      negotiable: /negotiable/i.test(cardText),
      location,
      sellerType,
      badge,
      imageUrl,
    };
  });

  return {
    totalCount: parseTotalCount($),
    count: listings.length,
    page,
    listings,
    sourceUrl: finalUrl,
  };
}
