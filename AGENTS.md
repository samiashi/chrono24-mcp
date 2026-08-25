# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

An MCP server (`chrono24-mcp`) exposing Chrono24 watch-marketplace tools to LLM clients over stdio. There is no official Chrono24 API; all data comes from scraping Chrono24's website through a real browser to pass their Cloudflare managed challenge. TypeScript, official MCP SDK, zod schemas, cheerio parsers.

## Commands

```bash
npm ci            # install exactly per lockfile
npm run build     # tsc -> build/
npm run smoke     # LIVE end-to-end test: spawns server, lists tools, searches, fetches detail (needs Google Chrome; hits chrono24.com)
node build/index.js   # run the server manually on stdio
```

There are no unit tests yet. Do NOT add live-network tests to CI: GitHub runners' IPs are blocked by Cloudflare. Parser tests must use recorded HTML fixtures if introduced.

## Architecture

```
src/index.ts           MCP server entry: registers 3 tools, instructions, graceful shutdown
src/fetcher.ts         Playwright-core fetcher: persistent Chrome profile, challenge sniffing, politeness delay
src/parsers/search.ts  Search URL builder + listing-card parser (current markup era)
src/parsers/detail.ts  Detail page parser: schema.org Product JSON-LD + spec table
src/cache.ts           TTL cache (search 180s, detail 1800s)
src/config.ts          Env-var config
src/tools/schemas.ts   Zod input schemas (single source of truth for tool inputs)
```

## Hard rules

- Never `console.log` / write to **stdout** anywhere in server code - stdout carries the MCP stdio protocol. Log to stderr only.
- Keep requests serialized and slow (~3.5s spacing). Never add concurrency, lower delays, or batch parallel fetches - Cloudflare escalates and IP-blocks.
- Use `playwright-core` (not `playwright`) so installs never download browsers. Launch with `channel: "chrome"` against installed Google Chrome; bundled Chromium is fallback only.
- The browser profile dir (`~/.cache/chrono24-mcp/profile`) persists the Cloudflare clearance cookie across restarts - do not clear it programmatically or default it to a temp dir.

## Domain knowledge (learned the hard way)

- Search cards: `div.js-listing-item-container`; title lines `p.text-ellipsis`; price `p.wt-listing-item-price`; image attr is `img[data-lazy-sweet-spot-master-src]` with `_SIZE_` replaced by pixel width. Legacy fallback selector: `a.js-article-item` (old markup era).
- Total result count: parse leaf text nodes matching `N listings/results`. NEVER read JSON-LD `AggregateOffer.offerCount` (counts only the ~60 embedded offers).
- Detail pages: primary source is `<script type="application/ld+json">` Product node (`sku` = reference number, `offers` = price); supplement with the spec table. Neutral URL form `/watches/--id<ID>.htm` redirects to canonical.
- Two distinct dealer ids exist: `dealerId` (`data-dealer-id`, powers ratings) vs `customerId` (URL param, powers inventory search filter). Never conflate.
- Search URLs redirect to canonical brand/model pages (`/search/index.htm?...` -> `/rolex/submariner--mod1.htm?...`); always parse whatever page lands.
- Prices are pinned to USD via `currencyId=USD`.

## Releases

Automated by release-please + npm trusted publishing (see `.github/workflows/release.yml`). Commit messages MUST follow Conventional Commits: `feat:` bumps minor, `fix:` bumps patch, `!` = breaking/major, other prefixes release nothing. Never edit version in package.json manually; never push tags.

## Style

TypeScript strict, ES2022, NodeNext modules (use `.js` extensions in relative imports). No comments unless explaining non-obvious domain behavior. Tool names snake_case with stable names - if renaming a tool, keep old name as alias.
