import { z } from "zod";
import { config } from "../config.js";

export const searchInput = {
  query: z
    .string()
    .optional()
    .describe("Free-text search, e.g. 'Rolex Submariner'. Optional when filtering by manufacturerIds/models/reference instead"),
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
    .describe("Cap the number of listings returned (1-60); useful for shortlisting without parsing a full page"),
  certified: z.boolean().optional().describe("Only Chrono24 Certified listings"),
};

export const getWatchInput = {
  id: z
    .string()
    .regex(/^\d+$/)
    .describe("Chrono24 listing id (digits from a listing URL --id<id>.htm)"),
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
  brand: z
    .string()
    .describe("Brand name (e.g. 'Rolex'), brand id from list_brands (e.g. '221'), or slug"),
};

export type SearchArgs = z.infer<z.ZodObject<typeof searchInput>>;
export type GetWatchArgs = z.infer<z.ZodObject<typeof getWatchInput>>;
export type GetWatchesArgs = z.infer<z.ZodObject<typeof getWatchesInput>>;
export type ListBrandsArgs = z.infer<z.ZodObject<typeof listBrandsInput>>;
export type FindModelsArgs = z.infer<z.ZodObject<typeof findModelsInput>>;