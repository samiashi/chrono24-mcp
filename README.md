# chrono24-mcp

[Chrono24](https://www.chrono24.com/) watch-marketplace tools for any MCP-capable LLM client - Claude Code, Claude Desktop, Codex, Cursor, Windsurf and friends.

Search listings, shortlist by price/location/seller type, then pull full watch details (reference, movement, caliber, box & papers, dealer info, photos) without leaving your chat.

```
search_listings("Rolex Submariner", { sort: "price_asc" })
  -> 60 cards, totalCount 9145, USD prices
get_watch("48091925")
  -> Rolex Submariner Date, ref 16610, $10,307, caliber 3135, box+papers, 16 photos
```

## How it works

Chrono24 has no public API and sits behind a Cloudflare managed challenge that blocks plain HTTP (403). This server drives a **real Chrome via Playwright with a persistent profile**, so the Cloudflare clearance cookie is earned once and reused across restarts. Requests are serialized with ~3.5s spacing plus jitter to stay polite; responses are cached (search 3 min, details 30 min).

## Requirements

- Node >= 20
- Google Chrome installed (recommended). Without it, install the bundled-browser fallback once: `npx playwright install chromium`.
- First run may take ~15-30s to clear the Cloudflare challenge.

## Setup

No repo clone needed - run straight from npm with `npx`.

### Claude Code

```bash
claude mcp add chrono24 -- npx -y chrono24-mcp
```

or project scope via `.mcp.json`:

```json
{
  "mcpServers": {
    "chrono24": {
      "command": "npx",
      "args": ["-y", "chrono24-mcp"]
    }
  }
}
```

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "chrono24": {
      "command": "npx",
      "args": ["-y", "chrono24-mcp"]
    }
  }
}
```

### Codex CLI / ChatGPT desktop

Add to `~/.codex/config.toml` (shared by Codex CLI, IDE extension and desktop app):

```toml
[mcp_servers.chrono24]
command = "npx"
args = ["-y", "chrono24-mcp"]
tool_timeout_sec = 120
```

### Cursor

`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "chrono24": {
      "command": "npx",
      "args": ["-y", "chrono24-mcp"]
    }
  }
}
```

### Global install alternative

```bash
npm i -g chrono24-mcp
# then use "chrono24-mcp" as the command in any client config
```

### Run from source

```bash
git clone https://github.com/samiashi/chrono24-mcp.git
cd chrono24-mcp
npm install && npm run build && npm run smoke
```

## Tools

| Tool | Description |
| --- | --- |
| `search_listings` | Search with query + filters (brand id, reference, price range, condition, year, seller countries, certified), sort (`relevance`, `price_asc`, `price_desc`, `newest`, `popularity`) and paging. Returns up to 60 cards/page with id, url, title, USD price, location, seller type, thumbnail. |
| `get_watch` | Full detail for one listing id: reference, condition, year, movement/caliber/power reserve, case material/diameter, scope of delivery, location, description, all photo URLs, canonical URL, seller ids. |
| `get_watches` | Batch detail for up to 10 ids. Sequential and polite (~4s per uncached id); per-id failures don't break the batch. |

All prices are normalized to USD (`currencyId=USD`). Empty result sets are valid outcomes, not errors.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `REQUEST_DELAY_MS` | `3500` | Min spacing between Chrono24 requests. Raise it if you ever see challenges. |
| `HEADLESS` | `true` | Set `false` to run a visible browser (useful when a challenge needs manual completion once). |
| `CHROME_CHANNEL` | `true` | Prefer installed Google Chrome; set `false` to force bundled Chromium. |
| `PROFILE_DIR` | `~/.cache/chrono24-mcp/profile` | Browser profile holding the Cloudflare clearance cookie. |
| `SEARCH_CACHE_TTL_S` | `180` | Search cache TTL. |
| `DETAIL_CACHE_TTL_S` | `1800` | Detail cache TTL. |
| `MAX_BATCH` | `10` | Cap for `get_watches`. |
| `CURRENCY_ID` | `USD` | Price normalization currency. |
| `DEBUG` | `false` | Verbose fetch logging to stderr. |

## Troubleshooting

- **Cloudflare challenge timeout**: wait ~30s and retry once. If persistent, run the server once with `HEADLESS=false`, complete any interactive challenge, then switch back.
- **Slow first call**: the first request after a cold profile earns clearance; subsequent calls reuse it.
- **Chromium fallback missing browser**: run `npx playwright install chromium`.

## Roadmap

- Brand/model taxonomy resolution (`list_brands`, `find_models`)
- Dealer inventory + ratings (uses the two distinct Chrono24 dealer ids)
- Optional Streamable HTTP transport for hosted deployments
- Fixture-based parser tests against recorded HTML snapshots

## Disclaimer

Educational/research project. Not affiliated with, endorsed by, or associated with Chrono24 GmbH. Scraping may violate Chrono24's Terms of Service depending on jurisdiction and use; you are responsible for compliance. Rate limits are deliberately conservative - keep them that way.

## License

MIT
