import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const command = process.env.SMOKE_COMMAND ?? "node";
const args = process.env.SMOKE_ARGS ? JSON.parse(process.env.SMOKE_ARGS) : ["build/index.js"];
const transport = new StdioClientTransport({
  command,
  args,
  ...(process.env.SMOKE_CWD ? { cwd: process.env.SMOKE_CWD } : {}),
});
const client = new Client({ name: "smoke", version: "0.0.1" });

try {
  await client.connect(transport);

  const tools = await client.listTools();
  console.error(`smoke: tools = ${tools.tools.map((t) => t.name).join(", ")}`);

  const res = await client.callTool({
    name: "search_listings",
    arguments: { query: process.env.SMOKE_QUERY ?? "Rolex Submariner" },
  });
  const payload = JSON.parse(res.content[0].text);
  if (res.isError) throw new Error(`search failed: ${payload}`);
  console.error(
    `smoke: search ok -> totalCount=${payload.totalCount} count=${payload.count}`
  );
  const firstId = payload.listings.find((l) => l.id)?.id;
  if (firstId) {
    const detail = await client.callTool({
      name: "get_watch",
      arguments: { id: firstId },
    });
    const d = JSON.parse(detail.content[0].text);
    if (detail.isError) throw new Error(`get_watch failed: ${d}`);
    console.error(
      `smoke: get_watch ok -> ${d.brand} ${d.model} ref=${d.reference} price=${d.priceDisplay} images=${d.images.length}`
    );
  }
  console.error("smoke: PASS");
} finally {
  await client.close();
}