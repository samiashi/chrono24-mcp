export class TtlCache {
  private store = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(private maxEntries = 200) {}

  get<T>(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // re-insert so Map insertion order doubles as LRU recency
    this.store.delete(key);
    this.store.set(key, hit);
    return hit.value as T;
  }

  set(key: string, value: unknown, ttlS: number) {
    if (!Number.isFinite(ttlS) || ttlS <= 0) return;
    this.store.delete(key);
    if (this.store.size >= this.maxEntries) this.prune();
    while (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlS * 1000 });
  }

  get size() {
    return this.store.size;
  }

  private prune() {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) this.store.delete(key);
    }
  }
}
