import { writeFileSync, mkdirSync } from "node:fs";
import { load } from "cheerio";
import { Fetcher } from "../src/fetcher.js";
import { buildSearchUrl } from "../src/parsers/search.js";

mkdirSync("test/fixtures", { recursive: true });

const fetcher = new Fetcher();
try {
  const brand = await fetcher.fetch("https://www.chrono24.com/rolex/index.htm");
  writeFileSync("test/fixtures/brand-rolex.html", brand.html);

  const search = await fetcher.fetch(buildSearchUrl({ query: "Rolex Submariner", sortorder: "5" }));
  writeFileSync("test/fixtures/search-rolex-submariner.html", search.html);

  const detail = await fetcher.fetch("https://www.chrono24.com/watches/--id48091925.htm");
  writeFileSync("test/fixtures/detail-48091925.html", detail.html);

  const $ = load(brand.html);
  console.log("=== brand-pattern links /<slug>/index.htm ===");
  const brandLinks = new Map();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const m = href.match(/^\/([a-z0-9-]+)\/index\.htm/i);
    if (m && !brandLinks.has(m[1])) brandLinks.set(m[1], $(el).text().trim());
  });
  console.log("count:", brandLinks.size);
  for (const [slug, text] of [...brandLinks.entries()].slice(0, 40)) {
    console.log(`  ${slug} | "${text.slice(0, 50)}"`);
  }

  console.log("=== manufacturerIds= occurrences (with context) ===");
  const manIds = [...brand.html.matchAll(/.{60}manufacturerIds=(\d+)/g)];
  console.log("count:", manIds.length);
  for (const m of manIds.slice(0, 8)) console.log("  ..." + m[0].replace(/\s+/g, " ").slice(0, 110));

  console.log("=== man=<slug>...manufacturerIds=<id> pairs ===");
  const pairs = [...brand.html.matchAll(/man=([a-z0-9-]+)[^"']*?manufacturerIds=(\d+)/g)];
  console.log("count:", pairs.length, pairs.slice(0, 15).map((m) => `${m[1]}=${m[2]}`).join(", "));

  console.log("=== --mod model links on brand page ===");
  const modLinks = new Map();
  $("a[href*='--mod']").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const id = href.match(/--mod(\d+)/)?.[1];
    const text = $(el).text().trim();
    if (id && text && !modLinks.has(id)) modLinks.set(id, [href.slice(0, 70), text.slice(0, 50)]);
  });
  console.log("count:", modLinks.size);
  for (const [id, [href, text]] of [...modLinks.entries()].slice(0, 20)) {
    console.log(`  mod${id} | "${text}" | ${href}`);
  }

  console.log("=== select options ===");
  $("select").each((_, sel) => {
    const name = $(sel).attr("name") ?? $(sel).attr("id") ?? "?";
    const opts = $(sel).find("option");
    if (opts.length > 5) {
      console.log(`  select "${name}": ${opts.length} options, sample:`);
      opts.slice(0, 6).each((_, o) => console.log(`    value=${$(o).attr("value")} "${$(o).text().trim().slice(0, 40)}"`));
    }
  });

  console.log("=== inline JSON state scripts ===");
  $("script").each((_, el) => {
    const id = $(el).attr("id") ?? "";
    const type = $(el).attr("type") ?? "";
    const text = $(el).text();
    if (id || type === "application/json") {
      console.log(`  script id="${id}" type="${type}" len=${text.length}`);
    }
  });
} finally {
  await fetcher.close();
}