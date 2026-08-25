# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

An MCP server (`chrono24-mcp`) exposing Chrono24 watch-marketplace tools to LLM clients over stdio. There is no official Chrono24 API; all data comes from scraping Chrono24's website through a real browser to pass their Cloudflare managed challenge. TypeScript, official MCP SDK, zod schemas, cheerio parsers.

## Commands

```bash
npm ci              # install exactly per lockfile
npm run build       # tsc -> build/
npm run typecheck   # tsc --noEmit
npm run lint        # eslint (flat config in eslint.config.js)
npm run format      # prettier --write .
npm test            # vitest, offline parser tests against test/fixtures/*.html (safe for CI)
npm run smoke       # LIVE end-to-end test: spawns server, lists tools, searches, fetches detail (needs Google Chrome; hits chrono24.com)
npm run capture-fixtures  # LIVE: refresh test/fixtures by re-fetching brand/search/detail pages
node build/index.js   # run the server manually on stdio
```

Before committing run `npm run format && npm run lint && npm run typecheck && npm test` - CI (`.github/workflows/ci.yml`) runs exactly those plus build. Prettier config: 110 print width, double quotes, trailing commas. ESLint: typescript-eslint recommended + prettier compat; empty catch blocks are allowed.

Smoke overrides for testing a published package instead of the local build:

```bash
SMOKE_COMMAND=npx SMOKE_ARGS='["-y","chrono24-mcp@latest"]' SMOKE_CWD=/tmp npm run smoke
```

There are no unit tests yet. Do NOT add live-network tests to CI: GitHub runners' IPs are blocked by Cloudflare. Parser tests must use recorded HTML fixtures if introduced.

## Architecture

```
src/index.ts           MCP server entry: registers 5 tools, instructions, graceful shutdown
src/fetcher.ts         Playwright-core fetcher: persistent Chrome profile, challenge sniffing, politeness delay, stale SingletonLock recovery
src/parsers/search.ts  Search URL builder + listing-card parser (current markup era)
src/parsers/detail.ts  Detail page parser: schema.org Product JSON-LD + spec table
src/parsers/taxonomy.ts  Brand list (manufacturerIds select), model catalog (--mod links), drift warnings
src/cache.ts           TTL cache (search 180s, detail 1800s, taxonomy 86400s)
src/config.ts          Env-var config
src/tools/schemas.ts   Zod input schemas (single source of truth for tool inputs)
test/parsers.test.ts   Offline vitest suite over recorded fixtures - keep green, extend when parsers change
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
- Full brand taxonomy lives in the broad search page (`/search/index.htm?dosearch=true` with no query) inside `select[name="manufacturerIds"]` - 554 options with numeric ids. Brand pages only reveal their own id via `man=<slug>&...&manufacturerIds=<id>` query strings.
- `search?manufacturerIds=<id>` redirects to `/{slug}/index.htm` - that redirect is how a brand id resolves to its slug for model-catalog parsing.
- Model links are `/{brand-slug}/{model-slug}--mod<id>.htm`; brand pages also list cross-brand popular models (e.g. AP Royal Oak on the Rolex page), so always filter by the brand-slug path prefix. Link text is messy ("Rolex DaytonaAll listings", multiline) - strip "All listings" and the brand prefix.
- Non-brand slugs (`search`, `offer`, `dealerinfo`, ...) must be excluded wherever brand slugs are parsed (see `NON_BRAND_SLUGS`).
- Parsers emit `[schema-drift]` stderr warnings when selectors match nothing on a loaded page - if you see these in logs, Chrono24 changed their markup; refresh fixtures via `npm run capture-fixtures` and update selectors.

## Releases

Automated by release-please + npm trusted publishing (see `.github/workflows/release.yml`). Commit messages MUST follow Conventional Commits: `feat:` bumps minor, `fix:` bumps patch, `!` = breaking/major, other prefixes release nothing. The version base is pinned in `.release-please-manifest.json` - never edit version in package.json manually; never push tags.

## Style

TypeScript strict, ES2022, NodeNext modules (use `.js` extensions in relative imports). No comments unless explaining non-obvious domain behavior. Tool names snake_case with stable names - if renaming a tool, keep old name as alias.
