import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildPagedUrl,
  buildSearchUrl,
  detectCurrency,
  parseLocalizedNumber,
  parseSearchResults,
  partitionFacets,
  resolveSort,
  FACET_PARAM_ALLOWLIST,
} from "../src/parsers/search.js";
import { hasDetailContent, parseDetail } from "../src/parsers/detail.js";
import {
  brandSlugFromUrl,
  filterBrands,
  parseBrands,
  parseFacets,
  parseModels,
  resolveBrand,
} from "../src/parsers/taxonomy.js";
import { parseModelGuide } from "../src/parsers/guide.js";
import { parseRatings } from "../src/parsers/ratings.js";
import { computeStats, estimateStats } from "../src/parsers/stats.js";

const fixture = (name: string) => readFileSync(`test/fixtures/${name}`, "utf8");

describe("search parser", () => {
  const result = parseSearchResults(fixture("search-rolex-submariner.html"), "https://x/final", 1);

  it("parses total count", () => {
    expect(result.totalCount).toBeGreaterThan(0);
  });

  it("parses a full page of listing cards", () => {
    expect(result.count).toBe(60);
    expect(result.listings.length).toBe(60);
  });

  it("extracts structured fields from the first card", () => {
    const first = result.listings[0];
    expect(first.id).toMatch(/^\d+$/);
    expect(first.url).toContain("--id");
    expect(first.brandModel.toLowerCase()).toContain("rolex");
    expect(first.priceValue).toBeGreaterThan(0);
    expect(["dealer", "private"]).toContain(first.sellerType);
    expect(first.imageUrl).toContain("img.chrono24.com");
  });

  it("flags promoted listings without breaking the card shape", () => {
    for (const listing of result.listings) {
      expect(typeof listing.negotiable).toBe("boolean");
    }
  });
});

describe("search url builder", () => {
  it("builds a canonical search url", () => {
    const url = buildSearchUrl({
      query: "Rolex Submariner",
      priceTo: 15000,
      sortorder: resolveSort("price_asc"),
    });
    expect(url).toContain("dosearch=true");
    expect(url).toContain("query=Rolex+Submariner");
    expect(url).toContain("priceTo=15000");
    expect(url).toContain("sortorder=1");
    expect(url).toContain("currencyId=USD");
  });

  it("repeats countryIds as separate params", () => {
    const url = buildSearchUrl({ query: "rolex", countryIds: ["US", "DE"] });
    expect(url.match(/countryIds=/g)?.length).toBe(2);
    expect(url).toContain("countryIds=US");
    expect(url).toContain("countryIds=DE");
  });

  it("never emits paging params itself (paging happens on the canonical url)", () => {
    expect(buildSearchUrl({ query: "x" })).not.toMatch(/showpage/i);
  });

  it("folds referenceNumber into the free-text query (no working URL param exists)", () => {
    expect(buildSearchUrl({ query: "Rolex", referenceNumber: "116610lv" })).toContain("query=Rolex+116610lv");
    expect(buildSearchUrl({ referenceNumber: "116610lv" })).toContain("query=116610lv");
    expect(buildSearchUrl({ query: "Rolex", referenceNumber: "116610lv" })).not.toContain("referenceNumber=");
  });

  it("supports a per-request currency override", () => {
    expect(buildSearchUrl({ query: "x" })).toContain("currencyId=USD");
    expect(buildSearchUrl({ query: "x", currencyId: "EUR" })).toContain("currencyId=EUR");
  });
});

describe("paged url builder", () => {
  it("pages on the canonical redirect target with lowercase showpage", () => {
    const page1Request =
      "https://www.chrono24.com/search/index.htm?dosearch=true&query=Rolex+Submariner&sortorder=1&pageSize=60&currencyId=USD";
    const canonical = "https://www.chrono24.com/rolex/submariner--mod1.htm?dosearch=true&sortorder=1";
    const url = buildPagedUrl(canonical, page1Request, 3);
    expect(url).toContain("https://www.chrono24.com/rolex/submariner--mod1.htm?");
    expect(url).toContain("showpage=3");
    expect(url).toContain("query=Rolex+Submariner");
    expect(url).toContain("pageSize=60");
    expect(url).not.toContain("showPage");
  });

  it("keeps the /search path when no redirect happened (dealer inventory)", () => {
    const page1Request =
      "https://www.chrono24.com/search/index.htm?dosearch=true&customerId=25566&sortorder=1&pageSize=60&currencyId=USD";
    const url = buildPagedUrl(page1Request, page1Request, 2);
    expect(url).toContain("/search/index.htm?");
    expect(url).toContain("customerId=25566");
    expect(url).toContain("showpage=2");
  });
});

describe("facet partitioning", () => {
  it("splits allowlisted facets from ignored ones", () => {
    const { applied, ignored } = partitionFacets({
      caseMaterials: "4",
      countryIds: "US",
      usedOrNew: "new",
      bogus: "1",
    });
    expect(applied).toEqual({ caseMaterials: "4" });
    expect(ignored.sort()).toEqual(["bogus", "countryIds", "usedOrNew"]);
  });

  it("handles missing facets", () => {
    expect(partitionFacets(undefined)).toEqual({ applied: {}, ignored: [] });
  });
});

describe("currency detection", () => {
  it.each([
    ["$16,842", "USD"],
    ["AED 61,900", "AED"],
    ["€12.500", "EUR"],
    ["£9,100", "GBP"],
    ["CHF 8,900", "CHF"],
    ["HK$120,000", "HKD"],
    ["A$4,200", "AUD"],
  ])("detects %s as %s", (display, code) => {
    expect(detectCurrency([display])).toBe(code);
  });

  it("skips null displays and returns null when nothing matches", () => {
    expect(detectCurrency([null, undefined, "Price on request"])).toBeNull();
    expect(detectCurrency([null, "AED 5,000"])).toBe("AED");
  });
});

describe("localized number parsing", () => {
  it.each([
    ["$10,307", 10307],
    ["10.307 €", 10307],
    ["1.234.567", 1234567],
    ["1,234,567", 1234567],
    ["10,307.50", 10307.5],
    ["10.307,50", 10307.5],
    ["245", 245],
    ["9,140", 9140],
  ])("parses %s as %d", (input, expected) => {
    expect(parseLocalizedNumber(input)).toBe(expected);
  });

  it("returns null when there are no digits", () => {
    expect(parseLocalizedNumber("")).toBeNull();
    expect(parseLocalizedNumber(".,")).toBeNull();
  });
});

describe("detail parser", () => {
  const detail = parseDetail(fixture("detail-48091925.html"));

  it("parses the JSON-LD product core", () => {
    expect(detail.brand).toBe("Rolex");
    expect(detail.model).toBe("Submariner Date");
    expect(detail.reference).toBe("16610");
    expect(detail.priceValue).toBe(10307);
    expect(detail.currency).toBe("USD");
  });

  it("parses spec-table supplements", () => {
    expect(detail.movement).toBe("Automatic");
    expect(detail.caseMaterial).toBe("Steel");
    expect(detail.caseDiameter).toBe("40 mm");
    expect(detail.scope).toBe("Original box, original papers");
    expect(detail.specs["caliber/movement"]).toBe("3135");
  });

  it("collects the photo set", () => {
    expect(detail.images.length).toBeGreaterThan(5);
    expect(detail.images[0]).toContain("img.chrono24.com");
  });

  it("recognizes a real detail page as having content", () => {
    expect(hasDetailContent(detail)).toBe(true);
  });

  it("surfaces availability and the ships-within estimate", () => {
    expect(detail.availability.length).toBeGreaterThan(0);
    expect(detail.shipsWithin).toMatch(/\d+.*days?/i);
  });

  it("flags a page with no product data as empty (removed listing)", () => {
    const empty = parseDetail(
      "<html><body><p>Nothing to see here, just a redirect target.</p></body></html>",
    );
    expect(hasDetailContent(empty)).toBe(false);
  });

  it("falls back to spec-table rows when a page has no JSON-LD Product (accessories)", () => {
    const html = `<html><body><table>
      <tr><th>Brand</th><td>Rolex</td></tr>
      <tr><th>Price</th><td>$225</td></tr>
      <tr><th>Reference number</th><td>63600</td></tr>
      <tr><th>Condition</th><td>Good</td></tr>
    </table></body></html>`;
    const d = parseDetail(html);
    expect(d.brand).toBe("Rolex");
    expect(d.priceDisplay).toBe("$225");
    expect(d.priceValue).toBe(225);
    expect(d.reference).toBe("63600");
    expect(hasDetailContent(d)).toBe(true);
  });

  it("prefers the converted amount in dual-currency spec prices", () => {
    const html = `<html><body><table>
      <tr><th>Brand</th><td>Rolex</td></tr>
      <tr><th>Price</th><td>€79 (= $94) [Negotiable]</td></tr>
    </table></body></html>`;
    const d = parseDetail(html);
    expect(d.priceValue).toBe(94);
    expect(d.priceDisplay).toContain("€79");
  });

  it("accepts a numeric JSON-LD price", () => {
    const html = `<html><body><script type="application/ld+json">
      {"@type":"Product","brand":{"name":"Rolex"},"model":"Daytona","sku":"116500",
       "offers":{"price":34500,"priceCurrency":"USD"}}
    </script></body></html>`;
    const d = parseDetail(html);
    expect(d.priceValue).toBe(34500);
    expect(d.priceDisplay).toBe("34500 USD");
    expect(d.currency).toBe("USD");
  });
});

describe("taxonomy parsers", () => {
  const brands = parseBrands(fixture("search-broad.html"));

  it("parses the full manufacturer select, deduplicated", () => {
    expect(brands.length).toBeGreaterThanOrEqual(500);
    expect(brands.length).toBe(new Set(brands.map((b) => b.id)).size);
    expect(brands).toContainEqual({ id: "221", name: "Rolex" });
    expect(brands).toContainEqual({ id: "18", name: "Audemars Piguet" });
  });

  it("filters and resolves brands", () => {
    expect(filterBrands(brands, "lange").length).toBeGreaterThan(0);
    expect(resolveBrand(brands, "221")?.name).toBe("Rolex");
    expect(resolveBrand(brands, "rolex")?.id).toBe("221");
    expect(resolveBrand(brands, "patek")?.name).toContain("Patek");
    expect(resolveBrand(brands, "nonexistentbrandxyz")).toBeNull();
  });

  it("tolerates surrounding whitespace and missing diacritics", () => {
    expect(resolveBrand(brands, " rolex ")?.id).toBe("221");
    expect(resolveBrand(brands, " 221 ")?.name).toBe("Rolex");
    expect(filterBrands(brands, "sohne").some((b) => b.name.includes("Söhne"))).toBe(true);
    expect(resolveBrand(brands, "lange & sohne")?.name).toContain("Söhne");
  });

  it("parses brand-scoped model links with cleaned names", () => {
    const models = parseModels(fixture("brand-rolex.html"), "rolex", "Rolex");
    expect(models.length).toBeGreaterThan(10);
    const byId = new Map(models.map((m) => [m.modelId, m]));
    expect(byId.get("1")?.slug).toBe("submariner");
    expect(byId.get("2")?.slug).toBe("daytona");
    expect(byId.get("45")?.slug).toBe("datejust");
    expect(byId.get("4")?.name).toBe("GMT-Master II");
    for (const model of models) {
      expect(model.name).not.toMatch(/All listings/i);
      expect(model.name).not.toMatch(/from \$/i);
      expect(model.name).not.toMatch(/^Rolex\s/i);
      expect(model.slug).not.toContain("/");
    }
    expect(models.every((m) => !["116", "106"].includes(m.modelId))).toBe(true);
  });

  it("strips the 'Model:' filter-chip label and accepts absolute hrefs", () => {
    const html = `
      <a href="/rolex/submariner--mod1.htm">RolexModel: Submariner</a>
      <a href="https://www.chrono24.com/rolex/daytona--mod2.htm">Rolex Daytona</a>
      <a href="/rolex/gmt-master-ii--mod4.htm">Model: GMT-Master II</a>`;
    const models = parseModels(html, "rolex", "Rolex");
    const byId = new Map(models.map((m) => [m.modelId, m]));
    expect(byId.get("1")?.name).toBe("Submariner");
    expect(byId.get("2")?.name).toBe("Daytona");
    expect(byId.get("4")?.name).toBe("GMT-Master II");
  });

  it("extracts brand slugs from urls", () => {
    expect(brandSlugFromUrl("https://www.chrono24.com/rolex/index.htm?x=1")).toBe("rolex");
    expect(brandSlugFromUrl("https://www.chrono24.com/rolex/submariner--mod1.htm?dosearch=true")).toBe(
      "rolex",
    );
    expect(brandSlugFromUrl("https://www.chrono24.com/search/index.htm")).toBeNull();
    expect(brandSlugFromUrl("https://www.chrono24.com/offer/index.htm")).toBeNull();
  });
});

describe("facet parser", () => {
  const facets = parseFacets(fixture("search-broad.html"));

  it("parses facet selects with options, skipping non-facets", () => {
    const names = facets.map((f) => f.name);
    expect(names).toContain("caseMaterials");
    expect(names).toContain("braceletMaterial");
    expect(names).toContain("gender");
    expect(names).toContain("countryIds");
    expect(names).not.toContain("manufacturerIds");
    expect(names).not.toContain("sortorder");
    expect(names).not.toContain("appearance");
  });

  it("caseMaterials contains steel with a numeric value", () => {
    const caseMaterials = facets.find((f) => f.name === "caseMaterials");
    expect(caseMaterials).toBeDefined();
    const steel = caseMaterials?.options.find((o) => o.label === "Steel");
    expect(steel?.value).toMatch(/^\d+$/);
  });
});

describe("price stats", () => {
  const search = parseSearchResults(fixture("search-rolex-submariner.html"), "https://x/final", 1);
  const prices = search.listings.map((l) => l.priceValue).filter((p): p is number => p !== null);

  it("computes bounded percentiles from search prices", () => {
    const stats = computeStats(prices);
    expect(stats).not.toBeNull();
    expect(stats!.sampleSize).toBe(prices.length);
    expect(stats!.min).toBeLessThanOrEqual(stats!.p10);
    expect(stats!.p10).toBeLessThanOrEqual(stats!.p25);
    expect(stats!.p25).toBeLessThanOrEqual(stats!.median);
    expect(stats!.median).toBeLessThanOrEqual(stats!.p75);
    expect(stats!.p75).toBeLessThanOrEqual(stats!.p90);
    expect(stats!.p90).toBeLessThanOrEqual(stats!.max);
    expect(stats!.min).toBeGreaterThan(0);
  });

  it("returns null for empty input", () => {
    expect(computeStats([])).toBeNull();
  });
});

describe("spread-sampled stats estimation", () => {
  const page = (pageNo: number, startPrice: number) =>
    Array.from({ length: 60 }, (_, i) => ({ rank: (pageNo - 1) * 60 + i + 1, price: startPrice + i }));

  it("interpolates population percentiles from first/middle/last pages", () => {
    const samples = [...page(1, 100), ...page(3, 500), ...page(5, 900)];
    const stats = estimateStats(samples, 300)!;
    expect(stats.sampleSize).toBe(180);
    expect(stats.min).toBe(100);
    expect(stats.max).toBe(959);
    expect(stats.p10).toBeGreaterThanOrEqual(125);
    expect(stats.p10).toBeLessThanOrEqual(135);
    expect(stats.median).toBeGreaterThanOrEqual(525);
    expect(stats.median).toBeLessThanOrEqual(535);
    expect(stats.p90).toBeGreaterThanOrEqual(925);
    expect(stats.p90).toBeLessThanOrEqual(935);
    expect(stats.p25).toBeLessThanOrEqual(stats.median);
    expect(stats.median).toBeLessThanOrEqual(stats.p75);
  });

  it("interpolates across the gaps between sampled pages", () => {
    const samples = [...page(1, 100), ...page(5, 900)];
    const stats = estimateStats(samples, 300)!;
    // rank 150 sits mid-gap between rank 60 (price 159) and rank 241 (price 900)
    expect(stats.median).toBeGreaterThan(159);
    expect(stats.median).toBeLessThan(900);
  });

  it("returns null with no samples", () => {
    expect(estimateStats([], 100)).toBeNull();
  });
});

describe("model guide parser", () => {
  const guide = parseModelGuide(fixture("model-rolex-submariner.html"));

  it("extracts editorial sections and filters boilerplate", () => {
    expect(guide.sections.length).toBeGreaterThanOrEqual(4);
    const headings = guide.sections.map((s) => s.heading);
    expect(headings.some((h) => /how much does/i.test(h))).toBe(true);
    expect(headings.some((h) => /newsletter|payment methods|theme/i.test(h))).toBe(false);
    for (const s of guide.sections) {
      expect(s.text.length).toBeGreaterThan(0);
      expect(s.text.length).toBeLessThanOrEqual(900);
    }
  });

  it("extracts the per-reference price table", () => {
    expect(guide.referencePrices.length).toBeGreaterThanOrEqual(10);
    const bond = guide.referencePrices.find((r) => /james bond/i.test(r.features));
    expect(bond).toBeDefined();
    expect(bond!.priceValue).toBeGreaterThan(100000);
    for (const r of guide.referencePrices) {
      expect(r.priceValue).not.toBeNull();
    }
  });

  it("returns empty structures for a page without guide content", () => {
    const empty = parseModelGuide("<html><body><p>nothing here</p></body></html>");
    expect(empty.sections).toEqual([]);
    expect(empty.referencePrices).toEqual([]);
  });
});

describe("dealer ratings parser", () => {
  const result = parseRatings(fixture("dealer-ratings.json"));

  it("parses totals and entries", () => {
    expect(result.total).toBeGreaterThan(0);
    expect(result.filteredTotal).toBe(result.total);
    expect(result.count).toBe(5);
    expect(result.offset).toBe(0);
  });

  it("lists the available star filters", () => {
    expect(result.availableStarFilters.length).toBeGreaterThan(0);
    expect(result.availableStarFilters[0]).toMatch(/star/i);
  });

  it("normalizes rating entries", () => {
    const first = result.ratings[0];
    expect(first.author.length).toBeGreaterThan(0);
    expect(first.rating).toBeGreaterThan(0);
    expect(first.rating).toBeLessThanOrEqual(5);
    expect(typeof first.recommendsSeller).toBe("boolean");
    expect(first.review.length).toBeGreaterThan(0);
    expect(first.watchTitle.length).toBeGreaterThan(0);
  });
});

describe("search facets passthrough", () => {
  it("builds url with allowlisted facet params", () => {
    const url = buildSearchUrl({ query: "rolex", facets: { caseMaterials: "4", braceletMaterial: "407" } });
    expect(url).toContain("caseMaterials=4");
    expect(url).toContain("braceletMaterial=407");
  });

  it("drops non-allowlisted facet params", () => {
    const url = buildSearchUrl({ query: "rolex", facets: { evilParam: "x", caseMaterials: "4" } });
    expect(url).not.toContain("evilParam");
    expect(url).toContain("caseMaterials=4");
  });

  it("allowlist covers the documented facet names", () => {
    for (const name of ["caseMaterials", "braceletMaterial", "gender", "watchCategories", "maxAgeInDays"]) {
      expect(FACET_PARAM_ALLOWLIST.has(name)).toBe(true);
    }
  });
});
