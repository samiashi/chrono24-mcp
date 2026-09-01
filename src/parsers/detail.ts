import { load, type CheerioAPI } from "cheerio";
import { parseLocalizedNumber } from "./search.js";
import { warnDrift } from "./taxonomy.js";

export interface WatchDetail {
  id?: string;
  canonicalUrl?: string;
  brand: string;
  model: string;
  reference: string;
  priceDisplay: string;
  priceValue: number | null;
  currency: string;
  condition: string;
  year: string;
  movement: string;
  caseMaterial: string;
  caseDiameter: string;
  gender: string;
  scope: string;
  availability: string;
  shipsWithin?: string;
  description: string;
  location: string;
  images: string[];
  specs: Record<string, string>;
}

type JsonNode = Record<string, unknown>;

function collectJsonLd($: CheerioAPI): JsonNode[] {
  const blocks: JsonNode[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).text());
      if (Array.isArray(data)) {
        for (const item of data) {
          if (item && typeof item === "object") blocks.push(item as JsonNode);
        }
      } else if (data && typeof data === "object") {
        blocks.push(data as JsonNode);
      }
    } catch {}
  });
  return blocks;
}

function isProduct(node: JsonNode): boolean {
  const types = Array.isArray(node["@type"]) ? (node["@type"] as string[]) : [node["@type"]];
  return types.includes("Product");
}

function findProductNode(blocks: JsonNode[]): JsonNode | null {
  for (const b of blocks) {
    if (isProduct(b)) return b;
  }
  for (const b of blocks) {
    const graph = b["@graph"];
    if (Array.isArray(graph)) {
      const sub = findProductNode(graph as JsonNode[]);
      if (sub) return sub;
    }
  }
  return null;
}

function extractSpecTable($: CheerioAPI): Record<string, string> {
  const specs: Record<string, string> = {};
  $("table th").each((_, th) => {
    const $th = $(th);
    const label = $th.text().trim();
    const value = $th.next("td").text().trim();
    if (label && value) {
      specs[label.toLowerCase().replace(/[:.]$/, "").replace(/\s+/g, " ")] = value
        .replace(/\s+/g, " ")
        .trim();
    }
  });
  return specs;
}

function cleanImage(v: unknown): string | null {
  if (typeof v === "string" && v) return v;
  if (v && typeof v === "object") {
    const url = (v as JsonNode)["contentUrl"];
    if (typeof url === "string" && url) return url;
  }
  return null;
}

function asStringArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v !== null && v !== undefined) return [v];
  return [];
}

export function extractCustomerId(html: string): string | null {
  // prefer the id inside a link so a stray mention elsewhere can't win
  const m = html.match(/href="[^"]*customerId=(\d+)/) ?? html.match(/customerId=(\d+)/);
  return m?.[1] ?? null;
}

export function extractDealerId(html: string): string | null {
  const m = html.match(/data-dealer-id="(\d+)"/);
  return m?.[1] ?? null;
}

// A dead/removed listing redirects away or renders a page with neither the
// JSON-LD Product nor a spec table - everything parses to empty strings.
export function hasDetailContent(d: Omit<WatchDetail, "id" | "canonicalUrl">): boolean {
  return Boolean(d.brand || d.model || d.reference || d.images.length > 0 || Object.keys(d.specs).length > 0);
}

// pages embed "The item is in stock and ready to ship within <strong>1 - 3
// days</strong>" (often HTML-escaped inside embedded JSON) - pull the window
// after the marker and strip tags/entities to recover the "1 - 3 days" part
function extractShipsWithin(html: string): string | undefined {
  const i = html.search(/ready to ship within/i);
  if (i === -1) return undefined;
  const window = html
    .slice(i + "ready to ship within".length, i + 120)
    .replace(/&lt;[^&]*?&gt;|<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\\+/g, " ");
  const m = window.match(/([\d]+\s*[-–]?\s*\d*\s*(?:business\s+)?days?)/i);
  return m ? m[1].replace(/\s+/g, " ").trim() : undefined;
}

// spec-table prices read like "€79 (= $94) [Negotiable]" - prefer the
// session-currency conversion in parentheses, else the first number token,
// and never concatenate digits across the two amounts
function parseSpecPrice(raw: string): number | null {
  const converted = raw.match(/\(=\s*[^\d]*([\d.,]+)/);
  const token = converted?.[1] ?? raw.match(/[\d.,]+/)?.[0];
  return token ? parseLocalizedNumber(token) : null;
}

export function parseDetail(html: string): Omit<WatchDetail, "id" | "canonicalUrl"> {
  const $ = load(html);
  const product = findProductNode(collectJsonLd($));
  const specs = extractSpecTable($);
  if (!product && Object.keys(specs).length === 0) {
    warnDrift("detail", "no JSON-LD Product and no spec table rows found");
  }
  const get = (...keys: string[]): string => {
    for (const k of keys) {
      const found = Object.entries(specs).find(([label]) => label === k || label.includes(k));
      if (found) return found[1];
    }
    return "";
  };

  const images: string[] = [];
  for (const img of asStringArray(product?.["image"])) {
    const url = cleanImage(img);
    if (url) images.push(url);
  }

  const offers = asStringArray(product?.["offers"]);
  const offerNode = offers[0] as JsonNode | undefined;
  const priceRaw = offerNode?.["price"];
  const offerPrice =
    typeof priceRaw === "string" ? priceRaw : typeof priceRaw === "number" ? String(priceRaw) : undefined;
  // accessory/parts listings have no JSON-LD Product at all - the spec table
  // (brand, price, reference number rows) is the only structured source there
  const specPrice = specs["price"];
  const priceDisplay = offerPrice
    ? `${offerPrice} ${typeof offerNode?.["priceCurrency"] === "string" ? offerNode["priceCurrency"] : ""}`.trim()
    : (specPrice ?? "");
  const priceValue = offerPrice
    ? Number(offerPrice.replace(/[^\d.]/g, "")) || null
    : specPrice
      ? parseSpecPrice(specPrice)
      : null;

  const brandNode = product?.["brand"];
  const brand = typeof brandNode === "string" ? brandNode : (brandNode as JsonNode | undefined)?.["name"];

  return {
    brand: (typeof brand === "string" ? brand : "") || get("brand"),
    model: (typeof product?.["model"] === "string" ? product["model"] : "") || get("model"),
    reference: (typeof product?.["sku"] === "string" ? product["sku"] : "") || get("reference number"),
    priceDisplay,
    priceValue,
    currency: typeof offerNode?.["priceCurrency"] === "string" ? offerNode["priceCurrency"] : "",
    condition: get("condition"),
    year: get("year of production"),
    movement: get("movement"),
    caseMaterial: get("case material"),
    caseDiameter: get("case diameter"),
    gender: get("gender"),
    scope: get("scope of delivery"),
    availability: get("availability"),
    shipsWithin: extractShipsWithin(html),
    description: typeof product?.["description"] === "string" ? product["description"] : "",
    location: get("location"),
    images,
    specs,
  };
}
