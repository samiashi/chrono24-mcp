import { load, type CheerioAPI } from "cheerio";

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
      specs[label.toLowerCase().replace(/[:.]$/, "").replace(/\s+/g, " ")] =
        value.replace(/\s+/g, " ").trim();
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
  const m = html.match(/customerId=(\d+)/);
  return m?.[1] ?? null;
}

export function extractDealerId(html: string): string | null {
  const m = html.match(/data-dealer-id="(\d+)"/);
  return m?.[1] ?? null;
}

export function parseDetail(html: string): Omit<WatchDetail, "id" | "canonicalUrl"> {
  const $ = load(html);
  const product = findProductNode(collectJsonLd($));
  const specs = extractSpecTable($);
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
  const offerPrice = typeof offerNode?.["price"] === "string" ? offerNode["price"] : undefined;
  const priceDisplay = offerPrice
    ? `${offerPrice} ${typeof offerNode?.["priceCurrency"] === "string" ? offerNode["priceCurrency"] : ""}`.trim()
    : "";
  const priceValue = offerPrice ? Number(offerPrice.replace(/[^\d.]/g, "")) || null : null;

  const brandNode = product?.["brand"];
  const brand =
    typeof brandNode === "string" ? brandNode : (brandNode as JsonNode | undefined)?.["name"];

  return {
    brand: typeof brand === "string" ? brand : "",
    model: typeof product?.["model"] === "string" ? product["model"] : "",
    reference: typeof product?.["sku"] === "string" ? product["sku"] : "",
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
    description: typeof product?.["description"] === "string" ? product["description"] : "",
    location: get("location"),
    images,
    specs,
  };
}