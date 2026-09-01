export interface DealerRating {
  author: string;
  country: string;
  date: string;
  watchTitle: string;
  rating: number;
  recommendsSeller: boolean;
  review: string;
  dealerComment?: string;
}

export interface RatingsResult {
  total: number;
  filteredTotal: number;
  offset: number;
  count: number;
  availableStarFilters: string[];
  ratings: DealerRating[];
}

type RatingNode = {
  authorShortName?: unknown;
  countryCode?: unknown;
  date?: unknown;
  title?: unknown;
  recommendsSeller?: unknown;
  review?: { text?: unknown };
  dealerComment?: { text?: unknown };
  rating?: { average?: unknown };
};

const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);

export function parseRatings(json: string): RatingsResult {
  const data = JSON.parse(json) as {
    dealerRatingModels?: RatingNode[];
    paging?: { total?: unknown; filteredTotal?: unknown; offset?: unknown };
    ratingStarsFilter?: Array<{ label?: unknown }>;
  };
  const models = Array.isArray(data.dealerRatingModels) ? data.dealerRatingModels : [];
  const ratings: DealerRating[] = models.map((m) => ({
    author: str(m.authorShortName),
    country: str(m.countryCode),
    date: str(m.date),
    watchTitle: str(m.title),
    rating: Number(m.rating?.average ?? 0) || 0,
    recommendsSeller: m.recommendsSeller === true,
    review: str(m.review?.text).replace(/\s+/g, " ").trim(),
    dealerComment: m.dealerComment?.text ? str(m.dealerComment.text).replace(/\s+/g, " ").trim() : undefined,
  }));
  const total = Number(data.paging?.total ?? ratings.length) || 0;
  return {
    total,
    filteredTotal: Number(data.paging?.filteredTotal ?? total) || 0,
    offset: Number(data.paging?.offset ?? 0) || 0,
    count: ratings.length,
    availableStarFilters: Array.isArray(data.ratingStarsFilter)
      ? data.ratingStarsFilter.map((f) => str(f?.label)).filter(Boolean)
      : [],
    ratings,
  };
}
