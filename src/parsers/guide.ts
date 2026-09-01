import { load } from "cheerio";
import { parseLocalizedNumber } from "./search.js";
import { warnDrift } from "./taxonomy.js";

export interface GuideSection {
  heading: string;
  text: string;
}

export interface ReferencePrice {
  model: string;
  price: string;
  priceValue: number | null;
  features: string;
}

export interface ModelGuide {
  sections: GuideSection[];
  referencePrices: ReferencePrice[];
}

const BOILERPLATE_HEADINGS =
  /newsletter|settings|theme|buy on chrono24|sell on chrono24|about chrono24|personalized support|chrono24 apps|payment methods|this page contains/i;

const MAX_SECTIONS = 12;
const MAX_SECTION_CHARS = 900;
const MAX_PRICE_ROWS = 60;

// Model pages carry server-rendered SEO editorial: h2 sections (history,
// "How much does X cost?", investment notes, FAQs) and a per-reference
// price table ("Model, reference number | Price (approx.) | Features").
export function parseModelGuide(html: string): ModelGuide {
  const $ = load(html);

  const referencePrices: ReferencePrice[] = [];
  $("table tr").each((_, row) => {
    if (referencePrices.length >= MAX_PRICE_ROWS) return;
    const cells = $(row)
      .find("td")
      .toArray()
      .map((c) => $(c).text().replace(/\s+/g, " ").trim());
    if (cells.length < 2) return;
    const [model, price, features = ""] = cells;
    if (!model || !price || parseLocalizedNumber(price) === null) return;
    referencePrices.push({ model, price, priceValue: parseLocalizedNumber(price), features });
  });

  // editorial headings are h3s inside the SEO block (one intro h2); footer
  // h2s are boilerplate-filtered. Table text is skipped - it is returned
  // structured via referencePrices instead.
  const sections: GuideSection[] = [];
  $("h2, h3").each((_, el) => {
    if (sections.length >= MAX_SECTIONS) return;
    const heading = $(el).text().replace(/\s+/g, " ").trim();
    if (!heading || BOILERPLATE_HEADINGS.test(heading)) return;
    let text = "";
    let node = $(el).next();
    let hops = 0;
    while (node.length && hops++ < 14) {
      const tag = (node.prop("tagName") ?? "").toLowerCase();
      if (tag === "h2" || tag === "h3") break;
      if (tag !== "table") {
        const t = node.text().replace(/\s+/g, " ").trim();
        if (t) text += (text ? " " : "") + t;
      }
      if (text.length >= MAX_SECTION_CHARS) break;
      node = node.next();
    }
    if (text) sections.push({ heading, text: text.slice(0, MAX_SECTION_CHARS) });
  });

  if (sections.length === 0 && referencePrices.length === 0) {
    warnDrift("guide", "no editorial sections or reference price table found on model page");
  }
  return { sections, referencePrices };
}
