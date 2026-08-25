import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildSearchUrl,
  parseSearchResults,
  resolveSort,
  FACET_PARAM_ALLOWLIST,
} from "../src/parsers/search.js";
import { parseDetail } from "../src/parsers/detail.js";
import {
  brandSlugFromUrl,
  filterBrands,
  parseBrands,
  parseFacets,
  parseModels,
  resolveBrand,
} from "../src/parsers/taxonomy.js";
import { parseRatings } from "../src/parsers/ratings.js";
import { computeStats } from "../src/parsers/stats.js";

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

  it("omits showPage for page 1 and includes it beyond", () => {
    expect(buildSearchUrl({ query: "x" })).not.toContain("showPage");
    expect(buildSearchUrl({ query: "x", page: 3 })).toContain("showPage=3");
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

describe("dealer ratings parser", () => {
  const result = parseRatings(fixture("dealer-ratings.json"));

  it("parses totals and entries", () => {
    expect(result.total).toBeGreaterThan(0);
    expect(result.count).toBe(5);
    expect(result.offset).toBe(0);
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
