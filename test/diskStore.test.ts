import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { diskRead, diskWrite } from "../src/diskStore.js";

const dir = mkdtempSync(path.join(tmpdir(), "chrono24-diskstore-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("diskStore", () => {
  it("round-trips values and reports remaining TTL", () => {
    const file = path.join(dir, "a.json");
    diskWrite(file, "k", { hello: "world" }, 3600);
    const hit = diskRead<{ hello: string }>(file, "k", 3600);
    expect(hit?.value).toEqual({ hello: "world" });
    expect(hit?.remainingS).toBeGreaterThan(3590);
    expect(hit?.remainingS).toBeLessThanOrEqual(3600);
  });

  it("misses expired entries and unknown keys", () => {
    const file = path.join(dir, "b.json");
    writeFileSync(file, JSON.stringify({ old: { at: Date.now() - 10_000_000, v: 1 } }));
    expect(diskRead(file, "old", 3600)).toBeNull();
    expect(diskRead(file, "never", 3600)).toBeNull();
  });

  it("prunes stale entries on write", () => {
    const file = path.join(dir, "c.json");
    writeFileSync(
      file,
      JSON.stringify({
        stale: { at: Date.now() - 10_000_000, v: 1 },
        fresh: { at: Date.now(), v: 2 },
      }),
    );
    diskWrite(file, "newkey", 3, 3600);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(raw).sort()).toEqual(["fresh", "newkey"]);
  });

  it("tolerates a missing or corrupt file", () => {
    expect(diskRead(path.join(dir, "missing.json"), "k", 60)).toBeNull();
    const file = path.join(dir, "corrupt.json");
    writeFileSync(file, "not json{{{");
    expect(diskRead(file, "k", 60)).toBeNull();
    diskWrite(file, "k", "v", 60);
    expect(diskRead<string>(file, "k", 60)?.value).toBe("v");
  });

  it("tolerates entries with a bogus timestamp", () => {
    const file = path.join(dir, "d.json");
    writeFileSync(file, JSON.stringify({ k: { at: "yesterday", v: 1 } }));
    expect(diskRead(file, "k", 60)).toBeNull();
  });
});
