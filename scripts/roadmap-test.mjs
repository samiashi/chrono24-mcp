import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["build/index.js"] });
const client = new Client({ name: "roadmap-test", version: "0.0.1" });

const parse = (res) => {
  if (res.isError) throw new Error(res.content[0].text);
  return JSON.parse(res.content[0].text);
};

try {
  await client.connect(transport);

  const filters = parse(
    await client.callTool({ name: "list_filters", arguments: { name: "caseMaterials" } }),
  );
  console.error(
    `list_filters(caseMaterials) -> ${filters.count} options, sample: ${filters.options
      .slice(0, 4)
      .map((o) => `${o.label}=${o.value}`)
      .join(", ")}`,
  );

  const steelId = filters.options.find((o) => o.label === "Steel")?.value;

  const stats = parse(
    await client.callTool({
      name: "get_price_stats",
      arguments: {
        query: "Omega Speedmaster Professional",
        priceTo: 20000,
        facets: steelId ? { caseMaterials: steelId } : {},
      },
    }),
  );
  console.error(
    `get_price_stats(Speedmaster Pro <=$20k${steelId ? ", steel" : ""}) -> totalCount=${stats.totalCount} stats=${JSON.stringify(stats.stats)}`,
  );

  const watch = parse(await client.callTool({ name: "get_watch", arguments: { id: "48091925" } }));
  const { customerId, dealerId } = watch.sellerIds;
  console.error(`get_watch sellerIds -> customerId=${customerId} dealerId=${dealerId}`);

  const listings = parse(await client.callTool({ name: "get_dealer_listings", arguments: { customerId } }));
  console.error(
    `get_dealer_listings(${customerId}) -> totalCount=${listings.totalCount} count=${listings.count}, first: ${listings.listings[0]?.brandModel} ${listings.listings[0]?.priceDisplay}`,
  );

  const ratings = parse(
    await client.callTool({ name: "get_dealer_ratings", arguments: { dealerId, size: 3 } }),
  );
  console.error(
    `get_dealer_ratings(${dealerId}) -> total=${ratings.total}, sample: "${ratings.ratings[0]?.author}" ${ratings.ratings[0]?.rating}/5 recommends=${ratings.ratings[0]?.recommendsSeller}`,
  );

  console.error("roadmap-test: PASS");
} finally {
  await client.close();
}
