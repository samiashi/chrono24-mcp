export interface PriceStats {
  sampleSize: number;
  min: number;
  p10: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
  max: number;
}

export interface RankedPrice {
  rank: number;
  price: number;
}

// Estimate population quantiles from pages sampled at known sorted ranks
// (e.g. first/middle/last price-ascending pages): linear interpolation
// between the nearest sampled ranks.
export function estimateStats(samples: RankedPrice[], total: number): PriceStats | null {
  if (samples.length === 0 || total <= 0) return null;
  const sorted = [...samples].sort((a, b) => a.rank - b.rank);
  const priceAtRank = (target: number): number => {
    if (target <= sorted[0].rank) return sorted[0].price;
    const last = sorted[sorted.length - 1];
    if (target >= last.rank) return last.price;
    for (let i = 0; i < sorted.length - 1; i++) {
      const lo = sorted[i];
      const hi = sorted[i + 1];
      if (lo.rank <= target && target <= hi.rank) {
        if (hi.rank === lo.rank) return lo.price;
        const f = (target - lo.rank) / (hi.rank - lo.rank);
        return Math.round(lo.price + f * (hi.price - lo.price));
      }
    }
    return last.price;
  };
  const at = (q: number) => priceAtRank(1 + q * (total - 1));
  return {
    sampleSize: sorted.length,
    min: sorted[0].price,
    p10: at(0.1),
    p25: at(0.25),
    median: at(0.5),
    p75: at(0.75),
    p90: at(0.9),
    max: sorted[sorted.length - 1].price,
  };
}

export function computeStats(prices: number[]): PriceStats | null {
  if (prices.length === 0) return null;
  const sorted = [...prices].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
  return {
    sampleSize: sorted.length,
    min: sorted[0],
    p10: at(0.1),
    p25: at(0.25),
    median: at(0.5),
    p75: at(0.75),
    p90: at(0.9),
    max: sorted[sorted.length - 1],
  };
}
