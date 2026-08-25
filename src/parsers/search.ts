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
  page?: number;
  pageSize?: number;
  certified?: boolean;
  customerId?: string;
  facets?: Record<string, string>;
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

export function buildSearchUrl(opts: SearchOptions): string {
  const qs = new URLSearchParams();
  qs.set("dosearch", "true");
  const put = (k: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  };
  put("query", opts.query);
  put("manufacturerIds", opts.manufacturerIds);
  put("models", opts.models);
  put("referenceNumber", opts.referenceNumber);
  put("priceFrom", opts.priceFrom);
  put("priceTo", opts.priceTo);
  put("usedOrNew", opts.usedOrNew);
  put("year", opts.year);
  for (const c of opts.countryIds ?? []) qs.append("countryIds", c);
  put("sortorder", opts.sortorder ?? "5");
  put("pageSize", opts.pageSize ?? 60);
  put("showPage", opts.page && opts.page > 1 ? opts.page : undefined);
  put("customerId", opts.customerId);
  if (opts.certified) qs.set("certified", "true");
  for (const [key, value] of Object.entries(opts.facets ?? {})) {
    if (FACET_PARAM_ALLOWLIST.has(key) && value) qs.set(key, value);
  }
  qs.set("currencyId", config.currencyId);
  return `${config.baseUrl}/search/index.htm?${qs.toString()}`;
}

const PRICE_VALUE_RE = /[\d.,]+/;

function parsePrice(display: string): { priceDisplay: string | null; priceValue: number | null } {
  const trimmed = display.trim();
  if (!trimmed || /price on request/i.test(trimmed)) return { priceDisplay: null, priceValue: null };
  const match = trimmed.match(PRICE_VALUE_RE);
  if (!match) return { priceDisplay: trimmed, priceValue: null };
  return { priceDisplay: trimmed, priceValue: Number(match[0].replace(/,/g, "")) };
}

const COUNT_LABEL_RE = /^\s*([\d.,]+)\s+(results?|watches?|listings?)\b/i;

function parseTotalCount($: CheerioAPI): number | null {
  for (const el of $("span, strong, p").toArray()) {
    const $el = $(el);
    if ($el.children().length > 0) continue;
    const text = $el.text().trim();
    const m = text.match(COUNT_LABEL_RE);
    if (m) return Number(m[1].replace(/[.,]/g, ""));
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
