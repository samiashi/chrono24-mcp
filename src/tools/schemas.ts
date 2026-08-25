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
  priceFrom: z.number().int().optional().describe("Minimum price in USD"),
  priceTo: z.number().int().optional().describe("Maximum price in USD"),
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
    .record(z.string())
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
  priceFrom: z.number().int().optional().describe("Minimum price in USD"),
  priceTo: z.number().int().optional().describe("Maximum price in USD"),
  condition: z.enum(["new", "used"]).optional(),
  year: z.number().int().optional(),
  countries: z.array(z.string().length(2)).max(10).optional(),
  facets: z.record(z.string()).optional().describe("Facet filters, see list_filters"),
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
};

export type SearchArgs = z.infer<z.ZodObject<typeof searchInput>>;
export type GetWatchArgs = z.infer<z.ZodObject<typeof getWatchInput>>;
export type GetWatchesArgs = z.infer<z.ZodObject<typeof getWatchesInput>>;
export type ListBrandsArgs = z.infer<z.ZodObject<typeof listBrandsInput>>;
export type FindModelsArgs = z.infer<z.ZodObject<typeof findModelsInput>>;
export type ListFiltersArgs = z.infer<z.ZodObject<typeof listFiltersInput>>;
export type GetPriceStatsArgs = z.infer<z.ZodObject<typeof getPriceStatsInput>>;
export type GetDealerListingsArgs = z.infer<z.ZodObject<typeof getDealerListingsInput>>;
export type GetDealerRatingsArgs = z.infer<z.ZodObject<typeof getDealerRatingsInput>>;
