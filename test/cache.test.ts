import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TtlCache } from "../src/cache.js";

describe("TtlCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns stored values before expiry and drops them after", () => {
    const cache = new TtlCache();
    cache.set("a", 1, 10);
    expect(cache.get("a")).toBe(1);
    vi.advanceTimersByTime(11_000);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("evicts the least recently used entry at capacity", () => {
    const cache = new TtlCache(3);
    cache.set("a", 1, 60);
    cache.set("b", 2, 60);
    cache.set("c", 3, 60);
    expect(cache.get("a")).toBe(1); // refresh "a" so "b" is now oldest
    cache.set("d", 4, 60);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    expect(cache.get("d")).toBe(4);
    expect(cache.size).toBe(3);
  });

  it("prefers dropping expired entries over live ones when full", () => {
    const cache = new TtlCache(2);
    cache.set("stale", 1, 5);
    cache.set("live", 2, 60);
    vi.advanceTimersByTime(6_000);
    cache.set("new", 3, 60);
    expect(cache.get("live")).toBe(2);
    expect(cache.get("new")).toBe(3);
    expect(cache.get("stale")).toBeUndefined();
  });

  it("overwrites an existing key without evicting others", () => {
    const cache = new TtlCache(2);
    cache.set("a", 1, 60);
    cache.set("b", 2, 60);
    cache.set("a", 10, 60);
    expect(cache.get("a")).toBe(10);
    expect(cache.get("b")).toBe(2);
  });

  it("ignores non-finite or non-positive TTLs instead of storing immortal entries", () => {
    const cache = new TtlCache();
    cache.set("nan", 1, Number.NaN);
    cache.set("zero", 2, 0);
    cache.set("neg", 3, -5);
    expect(cache.get("nan")).toBeUndefined();
    expect(cache.get("zero")).toBeUndefined();
    expect(cache.get("neg")).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});
