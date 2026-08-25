import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["build/index.js"] });
const client = new Client({ name: "taxonomy-test", version: "0.0.1" });

try {
  await client.connect(transport);

  const brands = await client.callTool({ name: "list_brands", arguments: { query: "rolex" } });
  const b = JSON.parse(brands.content[0].text);
  console.error(`list_brands("rolex") -> ${b.count}: ${JSON.stringify(b.brands)}`);

  const all = await client.callTool({ name: "list_brands", arguments: {} });
  const a = JSON.parse(all.content[0].text);
  console.error(`list_brands() -> ${a.count} brands, sample: ${a.brands.slice(0, 3).map((x) => `${x.name}=${x.id}`).join(", ")}`);

  const models = await client.callTool({ name: "find_models", arguments: { brand: "Rolex" } });
  const m = JSON.parse(models.content[0].text);
  console.error(`find_models("Rolex") -> brand=${JSON.stringify(m.brand)} count=${m.count}`);
  console.error(`  sample: ${m.models.slice(0, 8).map((x) => `${x.name} (${x.modelId})`).join(" | ")}`);

  const precise = await client.callTool({
    name: "search_listings",
    arguments: { manufacturerIds: m.brand.id, models: m.models.find((x) => x.slug === "submariner")?.modelId, priceTo: 15000, limit: 5 },
  });
  const p = JSON.parse(precise.content[0].text);
  console.error(`precise search (Rolex+Submariner, <=$15k) -> totalCount=${p.totalCount}, showing ${p.count}:`);
  for (const l of p.listings) console.error(`   ${l.brandModel} | ${l.priceDisplay} | ${l.location}`);
  console.error("taxonomy-test: PASS");
} finally {
  await client.close();
}