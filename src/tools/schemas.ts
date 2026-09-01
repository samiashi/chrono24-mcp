import { z } from "zod";
import { config } from "../config.js";

export const searchInput = {
  query: z
    .string()
    .optional()
    .describe(
      "Free-text search, e.g. 'Rolex Submariner'. Optional when filtering by manufacturerIds/models/reference instead",
    ),
  manufacturerIds: z
    .string()
    .optional()
    .describe("Chrono24 numeric brand id (Rolex=221). Optional; query text usually suffices"),
  models: z.string().optional().describe("Chrono24 numeric model id (digits from --mod URLs)"),
  referenceNumber: z.string().optional().describe("Reference number filter, e.g. '116610lv'"),
  priceFrom: z.number().int().optional().describe("Minimum price"),
  priceTo: z.number().int().optional().describe("Maximum price"),
  condition: z.enum(["new", "used"]).optional().describe("Condition filter"),
  year: z.number().int().optional().describe("Year of production filter"),
  countries: z
    .array(z.string().length(2))
    .max(10)
    .optional()
    .describe("ISO2 country codes to filter seller location, e.g. ['US','DE','CH']"),
  sort: z
    .enum(["relevance", "price_asc", "price_desc", "newest", "popularity"])
    .optional()
    .default("newest")
    .describe("Sort order"),
  page: z.number().int().min(1).optional().describe("1-based page number (60 results per page)"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(60)
    .optional()
    .describe(
      "Cap the number of listings returned (1-60); useful for shortlisting without parsing a full page",
    ),
  certified: z.boolean().optional().describe("Only Chrono24 Certified listings"),
  facets: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'Extra facet filters as param->value pairs, e.g. {"caseMaterials": "4", "braceletMaterial": "407"}. Discover names/values via list_filters',
    ),
};

export const getWatchInput = {
  id: z.string().regex(/^\d+$/).describe("Chrono24 listing id (digits from a listing URL --id<id>.htm)"),
};

export const getWatchesInput = {
  ids: z
    .array(z.string().regex(/^\d+$/))
    .min(1)
    .max(config.maxBatch)
    .describe(`Up to ${config.maxBatch} listing ids; each uncached id costs one polite request`),
};

export const listBrandsInput = {
  query: z
    .string()
    .optional()
    .describe("Optional case-insensitive substring filter on brand name, e.g. 'rolex' or 'lange'"),
};

export const findModelsInput = {
  brand: z.string().describe("Brand name (e.g. 'Rolex'), brand id from list_brands (e.g. '221'), or slug"),
};

export const listFiltersInput = {
  name: z
    .string()
    .optional()
    .describe("Optional exact select name to fetch, e.g. 'caseMaterials'. Omit to list all facets"),
};

export const getPriceStatsInput = {
  query: z.string().optional().describe("Free-text search scope"),
  manufacturerIds: z.string().optional().describe("Brand id from list_brands"),
  models: z.string().optional().describe("Model id from find_models"),
  referenceNumber: z.string().optional().describe("Reference number filter"),
  priceFrom: z.number().int().optional().describe("Minimum price"),
  priceTo: z.number().int().optional().describe("Maximum price"),
  condition: z.enum(["new", "used"]).optional(),
  year: z.number().int().optional(),
  countries: z.array(z.string().length(2)).max(10).optional(),
  facets: z.record(z.string(), z.string()).optional().describe("Facet filters, see list_filters"),
};

export const getDealerListingsInput = {
  customerId: z
    .string()
    .regex(/^\d+$/)
    .describe("Seller customerId from get_watch's sellerIds - powers a dealer's inventory"),
  page: z.number().int().min(1).optional(),
  sort: z.enum(["relevance", "price_asc", "price_desc", "newest", "popularity"]).optional().default("newest"),
};

export const getDealerRatingsInput = {
  dealerId: z
    .string()
    .regex(/^\d+$/)
    .describe("Dealer id from get_watch's sellerIds (NOT the customerId) - powers reviews"),
  size: z.number().int().min(1).max(50).optional().default(10).describe("Ratings per page (max 50)"),
  offset: z.number().int().min(0).optional().default(0).describe("Offset for paging through ratings"),
  stars: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe("Only reviews with this star rating (1-5); omit for all"),
};

export const getDealerRatingSummaryInput = {
  dealerId: z.string().regex(/^\d+$/).describe("Dealer id from get_watch's sellerIds (NOT the customerId)"),
};

// ---- output schemas (structuredContent) ----

const listingCard = z.object({
  id: z.string().nullable(),
  url: z.string(),
  brandModel: z.string(),
  detail: z.string(),
  priceDisplay: z.string().nullable(),
  priceValue: z.number().nullable(),
  negotiable: z.boolean(),
  location: z.string().nullable(),
  sellerType: z.enum(["dealer", "private"]).nullable(),
  badge: z.string().nullable(),
  imageUrl: z.string().nullable(),
});

const ignoredFacets = z
  .array(z.string())
  .optional()
  .describe(
    "Facet keys that were ignored because they are not passthrough params (e.g. countryIds -> use 'countries', usedOrNew -> use 'condition')",
  );

const searchPage = {
  totalCount: z.number().nullable(),
  count: z.number(),
  page: z.number(),
  totalPages: z.number().nullable(),
  hasMore: z.boolean().nullable(),
  currency: z.string(),
  listings: z.array(listingCard),
  sourceUrl: z.string(),
  ignoredFacets,
  note: z.string().optional(),
};

export const searchOutput = searchPage;

const watchDetailShape = {
  id: z.string().optional(),
  canonicalUrl: z.string().optional(),
  brand: z.string(),
  model: z.string(),
  reference: z.string(),
  priceDisplay: z.string(),
  priceValue: z.number().nullable(),
  currency: z.string(),
  condition: z.string(),
  year: z.string(),
  movement: z.string(),
  caseMaterial: z.string(),
  caseDiameter: z.string(),
  gender: z.string(),
  scope: z.string(),
  description: z.string(),
  location: z.string(),
  images: z.array(z.string()),
  specs: z.record(z.string(), z.string()),
};

const sellerIds = z
  .object({ customerId: z.string().nullable(), dealerId: z.string().nullable() })
  .optional()
  .describe("customerId powers get_dealer_listings; dealerId powers get_dealer_ratings");

export const getWatchOutput = {
  ...watchDetailShape,
  sellerIds,
};

export const getWatchesOutput = {
  count: z.number(),
  watches: z.array(z.object({ ...watchDetailShape, sellerIds, error: z.string().optional() })),
  note: z.string(),
};

export const listBrandsOutput = {
  count: z.number(),
  brands: z.array(z.object({ id: z.string(), name: z.string() })),
};

export const findModelsOutput = {
  count: z.number(),
  brand: z.object({ id: z.string(), name: z.string(), slug: z.string().optional() }).optional(),
  slug: z.string().optional(),
  models: z.array(z.object({ modelId: z.string(), slug: z.string(), name: z.string() })),
  note: z.string().optional(),
};

const facetOption = z.object({ value: z.string(), label: z.string() });
const facetPassthrough = z
  .boolean()
  .describe("Whether search_listings' facets param accepts this facet name");
const facetUseInstead = z
  .string()
  .optional()
  .describe("Dedicated search_listings param to use instead of this facet");

export const listFiltersOutput = {
  count: z.number(),
  facets: z
    .array(
      z.object({
        name: z.string(),
        options: z.array(facetOption),
        passthrough: facetPassthrough,
        useInstead: facetUseInstead,
      }),
    )
    .optional(),
  name: z.string().optional(),
  options: z.array(facetOption).optional(),
  passthrough: facetPassthrough.optional(),
  useInstead: facetUseInstead,
  note: z.string().optional(),
};

export const getPriceStatsOutput = {
  scope: z.object({
    query: z.string().nullable(),
    manufacturerIds: z.string().nullable(),
    models: z.string().nullable(),
  }),
  totalCount: z.number().nullable(),
  sourceUrl: z.string(),
  currency: z.string(),
  coverage: z
    .enum(["full", "cheapest-60"])
    .nullable()
    .describe("'full' when every matching listing was sampled; 'cheapest-60' means lower-tail bias"),
  stats: z
    .object({
      sampleSize: z.number(),
      min: z.number(),
      p10: z.number(),
      p25: z.number(),
      median: z.number(),
      p75: z.number(),
      p90: z.number(),
      max: z.number(),
    })
    .nullable(),
  cheapest: z.array(listingCard),
  ignoredFacets,
  note: z.string(),
};

export const getDealerListingsOutput = {
  customerId: z.string(),
  ...searchPage,
};

export const getDealerRatingsOutput = {
  dealerId: z.string(),
  total: z.number(),
  filteredTotal: z.number(),
  offset: z.number(),
  count: z.number(),
  availableStarFilters: z.array(z.string()),
  ratings: z.array(
    z.object({
      author: z.string(),
      country: z.string(),
      date: z.string(),
      watchTitle: z.string(),
      rating: z.number(),
      recommendsSeller: z.boolean(),
      review: z.string(),
      dealerComment: z.string().optional(),
    }),
  ),
};

export const getDealerRatingSummaryOutput = {
  dealerId: z.string(),
  total: z.number(),
  average: z
    .number()
    .nullable()
    .describe("Weighted average star rating (2 decimals); null when the dealer has no reviews"),
  histogram: z.object({
    "5": z.number(),
    "4": z.number(),
    "3": z.number(),
    "2": z.number(),
    "1": z.number(),
  }),
};
