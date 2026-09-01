import { describe, expect, it } from "vitest";
import { createSerializer } from "../src/fetcher.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createSerializer", () => {
  it("runs tasks strictly one at a time in submission order", async () => {
    const enqueue = createSerializer();
    const events: string[] = [];
    const task = (name: string, ms: number) =>
      enqueue(async () => {
        events.push(`${name}:start`);
        await sleep(ms);
        events.push(`${name}:end`);
        return name;
      });
    const [a, b, c] = await Promise.all([task("a", 30), task("b", 10), task("c", 1)]);
    expect([a, b, c]).toEqual(["a", "b", "c"]);
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  it("keeps the queue alive after a task rejects", async () => {
    const enqueue = createSerializer();
    const failing = enqueue(async () => {
      throw new Error("boom");
    });
    const following = enqueue(async () => "ok");
    await expect(failing).rejects.toThrow("boom");
    await expect(following).resolves.toBe("ok");
  });

  it("isolates rejections to their own caller", async () => {
    const enqueue = createSerializer();
    const results = await Promise.allSettled([
      enqueue(async () => 1),
      enqueue(async () => {
        throw new Error("mid");
      }),
      enqueue(async () => 3),
    ]);
    expect(results[0]).toEqual({ status: "fulfilled", value: 1 });
    expect(results[1].status).toBe("rejected");
    expect(results[2]).toEqual({ status: "fulfilled", value: 3 });
  });
});
