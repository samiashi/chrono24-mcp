# chrono24-mcp

[![npm](https://img.shields.io/npm/v/chrono24-mcp)](https://www.npmjs.com/package/chrono24-mcp)
[![CI](https://github.com/samiashi/chrono24-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/samiashi/chrono24-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/samiashi/chrono24-mcp/blob/main/LICENSE)

[Chrono24](https://www.chrono24.com/) watch-marketplace tools for any MCP-capable LLM client - Claude Code, Claude Desktop, Codex, Cursor, Windsurf and friends.

Search listings, shortlist by price/location/seller type, then pull full watch details (reference, movement, caliber, box & papers, dealer info, photos) without leaving your chat.

```
find_deals("Omega Speedmaster Professional")
  -> market median $6,850, 7 listings at or below p25, best 31% under median
get_watch("48091925")
  -> Rolex Submariner Date, ref 16610, $10,307, caliber 3135, box+papers, in stock, ships 1-3 days
get_dealer_rating_summary(dealerId)
  -> 4.83 stars across 10,128 reviews (8,895 five-star / 64 one-star)
get_model_guide("Rolex", "Submariner")
  -> history, price guidance and Chrono24's per-reference price table (6538 "James Bond" ~$148,000)
save_search("speedy-under-4k", { query: "Omega Speedmaster", priceTo: 4000 })
  -> check_saved_searches later reports only listings that appeared since
```

## How it works

Chrono24 has no public API and sits behind a Cloudflare managed challenge that blocks plain HTTP (403). This server drives a **real Chrome via Playwright with a persistent profile**, so the Cloudflare clearance cookie is earned once and reused across restarts. Requests are serialized with ~3.5s spacing plus jitter to stay polite; responses are cached (search 3 min, details 30 min), and brand/model taxonomy persists to disk so restarts stay warm. Long-running calls (`get_watches`, `get_dealer_rating_summary`, paged searches) emit MCP progress notifications - enable `resetTimeoutOnProgress` in clients that support it.

## Setup

Requires Node >= 22 and Google Chrome (the fallback bundled Chromium needs a one-time `npx playwright install chromium`). First run may take ~15-30s to clear the Cloudflare challenge.

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

| Tool              | Description                                                                                                                                                                                                                                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_brands`     | List all 550+ Chrono24 watch brands with numeric ids (optional name filter). Feed ids into `search_listings`' `manufacturerIds` or names into `find_models`.                                                                                                                                                                           |
| `find_models`     | A brand's model catalog: model name, slug and numeric model id (e.g. Rolex -> Submariner `mod1`, Daytona `mod2`). Pair with `search_listings`' `models` + `manufacturerIds` for precise searches.                                                                                                                                      |
| `list_filters`    | All search facet filters with allowed values (case material, bracelet material, gender, watch category, country, listing age). Use with `search_listings`' `facets` param.                                                                                                                                                             |
| `search_listings` | Search with query + filters (brand id, model id, reference, price range, condition, year, seller countries, facets), sort (`relevance`, `price_asc`, `price_desc`, `newest`, `popularity`), paging (`page`, plus `totalPages`/`hasMore` in the response) and an optional `limit` (1-60) for shortlisting. Returns cards with id, url, title, price, location, seller type, thumbnail. |
| `get_price_stats` | Price statistics: min, p10/p25/median/p75/p90, max and sample size. Default: one request over the 60 cheapest (lower-tail biased); `sample: "spread"` interpolates full-range percentiles from first/middle/last price-sorted pages (up to 3 requests). `coverage` reports which mode applied.                                         |
| `get_watch`       | Full detail for one listing id: reference, condition, year, movement/caliber/power reserve, case material/diameter, scope of delivery, location, description, all photo URLs, canonical URL, seller ids. Sold/removed listings return a clear not-found error instead of empty fields.                                                 |
| `get_watches`     | Batch detail for up to 10 ids. Sequential and polite (~4s per uncached id); per-id failures don't break the batch.                                                                                                                                                                                                                     |
| `get_dealer_listings` | A dealer's current inventory by `customerId` (from `get_watch`'s `sellerIds`). Same card shape as `search_listings`.                                                                                                                                                                                                              |
| `get_dealer_ratings` | A dealer's customer reviews by `dealerId` (from `get_watch`'s `sellerIds` - a different id!). Per-review rating, text, dealer reply, paging totals (`total`/`filteredTotal`); filter with `stars` (1-5).                                                                                                                              |
| `get_dealer_rating_summary` | Star histogram + weighted average rating for a dealer (e.g. 4.83 from 10,128 reviews), reconstructed from per-star counts. 5 lightweight requests (~8s uncached, cached 30 min) - the fast way to vet a dealer. `get_dealer_rating_summaries` batches up to 5 dealers in one call.                                        |
| `find_deals`      | The one-call answer to "find me a good deal on X": full-range price stats, then listings at or below market p25 with `pctBelowMedian` and caution flags. `benchmark: "global"` ranks country-filtered listings against the worldwide market; `sample: "cheapest"` is the 1-request fast mode.                                  |
| `search_all`      | Aggregate up to 5 result pages (300 listings) into one deduplicated list, with progress notifications. For exhaustive scans.                                                                                                                                                                                                        |
| `value_collection`| Appraise up to 10 watches in one call: per-item market stats plus portfolio totals (sum of medians/p25/p75).                                                                                                                                                                                                                        |
| `save_search` / `check_saved_searches` | Save a named search scope (persisted to disk), then later report **only listings that appeared since the last check** - built for scheduled agents ("tell me when a Speedmaster under $4k shows up"). Manage with `list_saved_searches` / `delete_saved_search`.                                            |
| `server_status`   | Diagnostics without network requests: browser state, request queue depth, cache/disk freshness, politeness settings.                                                                                                                                                                                                               |
| `get_model_guide` | Chrono24's editorial buying guide for a model: history, cost guidance, investment notes and the per-reference approximate price table (e.g. Submariner 6538 "James Bond" ~148,000 USD). One request, cached 24h.                                                                                                                   |
| `get_watch_photos`| A listing's photos as inline images (Large ~28KB each) so vision-capable clients can inspect condition and authenticity cues.                                                                                                                                                                                                       |
| `watch_listing` / `check_watched_listings` | Track specific listings for price drops and sold/removed status (persisted; `unwatch_listing` to stop). The listing-level counterpart to saved searches.                                                                                                                                                    |
| `health_check`    | Live canary (2 requests) asserting the parsing invariants: cards parse, counts present, details complete. Run when markup drift is suspected.                                                                                                                                                                                       |

Tools declare MCP annotations (`readOnlyHint`/`openWorldHint`; the saved-search tools declare their local writes), and every result is also returned as `structuredContent` with a matching output schema. `get_price_stats` accepts `sample: "spread"` for full-range percentile estimates (3 requests) instead of the default cheapest-60 sample. Three MCP prompts ship as guided recipes: `appraise_watch`, `vet_dealer` and `find_deal`.

**Currency**: Chrono24 assigns the session currency by server geolocation and ignores URL currency params (verified with fresh profiles) - it cannot be forced to e.g. AED. Every result's `currency` field reports the currency actually detected in the prices, so downstream conversion is at least unambiguous. Prices are pinned to the configured `CURRENCY_ID` (default USD) and echoed in each result's `currency` field; Chrono24 tracks currency per browser session, so there is no per-request override. Empty result sets are valid outcomes, not errors.

## Environment variables

| Variable               | Default                         | Purpose                                                                                      |
| ---------------------- | ------------------------------- | -------------------------------------------------------------------------------------------- |
| `REQUEST_DELAY_MS`     | `3500`                          | Min spacing between Chrono24 requests. Raise it if you ever see challenges.                  |
| `HEADLESS`             | `true`                          | Set `false` to run a visible browser (useful when a challenge needs manual completion once). |
| `CHROME_CHANNEL`       | `true`                          | Prefer installed Google Chrome; set `false` to force bundled Chromium.                       |
| `PROFILE_DIR`          | `~/.cache/chrono24-mcp/profile` | Browser profile holding the Cloudflare clearance cookie.                                     |
| `SEARCH_CACHE_TTL_S`   | `180`                           | Search cache TTL.                                                                            |
| `DETAIL_CACHE_TTL_S`   | `1800`                          | Detail cache TTL.                                                                            |
| `TAXONOMY_CACHE_TTL_S` | `86400`                         | Brand/model taxonomy cache TTL (also persisted to disk inside the profile dir).             |
| `MAX_BATCH`            | `10`                            | Cap for `get_watches`.                                                                       |
| `CURRENCY_ID`          | `USD`                           | Fallback for the reported `currency` field. The actual price currency is geo-assigned by Chrono24 and detected from responses.  |
| `NAVIGATION_TIMEOUT_MS`| `45000`                         | Playwright navigation timeout per request.                                                  |
| `CHALLENGE_TIMEOUT_MS` | `45000`                         | How long to wait for a Cloudflare challenge to clear.                                       |
| `CHRONO24_BASE_URL`    | `https://www.chrono24.com`      | Upstream base URL.                                                                          |
| `BLOCK_ASSETS`         | `false`                         | Skip downloading images/fonts/media for lower bandwidth (challenge resources always load).  |
| `JSON_REQUEST_DELAY_MS`| `1500`                          | Spacing for lightweight same-origin JSON API calls (dealer ratings). Page scrapes keep `REQUEST_DELAY_MS`. |
| `DEBUG`                | `false`                         | Verbose fetch logging to stderr.                                                             |

## Troubleshooting

- **Cloudflare challenge timeout**: wait ~30s and retry once. If persistent, run the server once with `HEADLESS=false`, complete any interactive challenge, then switch back.
- **Slow first call**: the first request after a cold profile earns clearance; subsequent calls reuse it.
- **Chromium fallback missing browser**: run `npx playwright install chromium`.

## Roadmap

Ideas welcome - open an issue.

## Disclaimer

Educational/research project. Not affiliated with, endorsed by, or associated with Chrono24 GmbH. Scraping may violate Chrono24's Terms of Service depending on jurisdiction and use; you are responsible for compliance. Rate limits are deliberately conservative - keep them that way.

## License

MIT
