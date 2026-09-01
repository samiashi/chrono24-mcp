import { load, type CheerioAPI } from "cheerio";

export interface Brand {
  id: string;
  name: string;
}

export interface BrandModel {
  modelId: string;
  slug: string;
  name: string;
}

export function warnDrift(context: string, detail: string) {
  console.error(`[schema-drift] ${context}: ${detail}`);
}

export function parseBrands(html: string): Brand[] {
  const $ = load(html);
  const brands = new Map<string, string>();
  $('select[name="manufacturerIds"] option').each((_, el) => {
    const id = ($(el).attr("value") ?? "").trim();
    const name = $(el).text().trim();
    if (id && name && !brands.has(id)) brands.set(id, name);
  });
  if (brands.size < 100) {
    warnDrift("taxonomy", `manufacturerIds select matched only ${brands.size} options`);
  }
  return [...brands.entries()].map(([id, name]) => ({ id, name }));
}

const NON_BRAND_SLUGS = new Set([
  "search",
  "offer",
  "offers",
  "dealer",
  "dealerinfo",
  "dealers",
  "watches",
  "faq",
  "help",
  "service",
  "magazine",
  "sell",
  "buy",
]);

export function brandSlugFromUrl(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const m = pathname.match(/^\/([a-z0-9-]+)(?:\/[^/]*)?\.htm/i);
  const slug = m?.[1] ?? null;
  return slug && !NON_BRAND_SLUGS.has(slug.toLowerCase()) ? slug : null;
}

function cleanModelName(text: string, brandName: string, slug: string): string {
  let name = text
    .replace(/All listings/gi, "")
    .replace(/\s+from\s+\$[\d,.]+[\s\S]*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const brandPrefix = new RegExp(`^${brandName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i");
  name = name.replace(brandPrefix, "").trim();
  // filter-chip links label the model as "RolexModel: Submariner" - the
  // "Model:" strip must run after the brand prefix strip
  name = name.replace(/^Model:\s*/i, "").trim();
  if (!name) {
    name = slug
      .split("-")
      .map((part) => (part.length <= 2 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)))
      .join(" ");
  }
  return name;
}

export function parseModels(html: string, brandSlug: string, brandName: string): BrandModel[] {
  const $ = load(html);
  const models = new Map<string, BrandModel>();
  $("a[href*='--mod']").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const m = href.match(new RegExp(`^(?:https?://[^/]+)?/${brandSlug}/([a-z0-9-]+)--mod(\\d+)\\.htm`, "i"));
    if (!m) return;
    const [, slug, modelId] = m;
    if (models.has(modelId)) return;
    const text = $(el).text();
    models.set(modelId, {
      modelId,
      slug,
      name: cleanModelName(text, brandName, slug),
    });
  });
  if (models.size === 0) {
    warnDrift("taxonomy", `0 model links matched for brand slug "${brandSlug}"`);
  }
  return [...models.values()];
}

// trim + case-fold + strip diacritics so "sohne" matches "A. Lange & Söhne"
export const normalizeText = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();
const normalizeBrandText = normalizeText;

export function filterBrands(brands: Brand[], query: string): Brand[] {
  const q = normalizeBrandText(query);
  return brands.filter((b) => normalizeBrandText(b.name).includes(q));
}

export function resolveBrand(brands: Brand[], input: string): Brand | null {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) {
    return brands.find((b) => b.id === trimmed) ?? { id: trimmed, name: trimmed };
  }
  const q = normalizeBrandText(trimmed);
  return (
    brands.find((b) => normalizeBrandText(b.name) === q) ??
    brands.find((b) => normalizeBrandText(b.name).includes(q)) ??
    null
  );
}

export interface Facet {
  name: string;
  options: Array<{ value: string; label: string }>;
}

const NON_FACET_SELECTS = new Set(["manufacturerIds", "sortorder", "appearance"]);

export function parseFacets(html: string): Facet[] {
  const $ = load(html);
  const facets: Facet[] = [];
  $("select[name]").each((_, el) => {
    const name = ($(el).attr("name") ?? "").trim();
    if (!name || NON_FACET_SELECTS.has(name)) return;
    const options: Array<{ value: string; label: string }> = [];
    $(el)
      .find("option")
      .each((__, opt) => {
        const value = ($(opt).attr("value") ?? "").trim();
        const label = $(opt).text().trim();
        if (value && label) options.push({ value, label });
      });
    if (options.length > 0) facets.push({ name, options });
  });
  if (facets.length < 3) {
    warnDrift("taxonomy", `only ${facets.length} facet selects found on search page`);
  }
  return facets;
}

export function countSelectOptions(html: string, name: string): number {
  const $: CheerioAPI = load(html);
  return $(`select[name="${name}"] option`).length;
}
