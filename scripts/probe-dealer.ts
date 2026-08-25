import { readFileSync, writeFileSync } from "node:fs";
import { extractCustomerId, extractDealerId } from "../src/parsers/detail.js";
import { Fetcher } from "../src/fetcher.js";
import { config } from "../src/config.js";

const html = readFileSync("test/fixtures/detail-48091925.html", "utf8");
const dealerId = extractDealerId(html);
const customerId = extractCustomerId(html);

const fetcher = new Fetcher();
try {
  if (dealerId) {
    const res = await fetcher.fetchJson(
      `${config.baseUrl}/api/merchant/ratings.json?dealerId=${dealerId}&size=5&offset=0&stars=0&sorting=Relevance`,
    );
    writeFileSync("test/fixtures/dealer-ratings.json", res.body);
    console.log("ratings status:", res.status, "bytes:", res.body.length);
    console.log(res.body.slice(0, 900));
  }
  if (customerId) {
    const listings = await fetcher.fetch(
      `${config.baseUrl}/search/index.htm?dosearch=true&customerId=${customerId}&sortorder=5&pageSize=60&currencyId=${config.currencyId}`,
    );
    writeFileSync("test/fixtures/dealer-listings.html", listings.html);
    console.log("\nlistings finalUrl:", listings.finalUrl, "bytes:", listings.html.length);
    const { load } = await import("cheerio");
    const $ = load(listings.html);
    console.log("cards:", $("div.js-listing-item-container").length);
  }
} finally {
  await fetcher.close();
}
