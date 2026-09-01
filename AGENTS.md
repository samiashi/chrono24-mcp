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

Do NOT add live-network tests to CI: GitHub runners' IPs are blocked by Cloudflare. Parser tests use recorded HTML fixtures in test/fixtures/.

## Architecture

```
src/index.ts           MCP server entry: registers 18 tools + 3 prompts via registerTool/registerPrompt (readOnlyHint annotations, output schemas + structuredContent), parsed-result caching, not-found detection, disk-persisted taxonomy, graceful shutdown (signals + stdin close)
src/fetcher.ts         Playwright-core fetcher: strict request serialization (createSerializer mutex - concurrent MCP tool calls share one page), persistent Chrome profile, memoized launch, crash recovery via context close listener, status-aware challenge sniffing, warmup-on-demand retry, politeness delay, stale SingletonLock recovery, in-page fetchJson for same-origin JSON APIs
src/parsers/search.ts  Search URL builder + listing-card parser (current markup era), facet param allowlist, locale-aware price parsing (parseLocalizedNumber)
src/parsers/detail.ts  Detail page parser: schema.org Product JSON-LD + spec table; hasDetailContent detects removed listings
src/parsers/taxonomy.ts  Brand list (manufacturerIds select), model catalog (--mod links), facet selects, drift warnings
src/parsers/ratings.ts Dealer ratings JSON normalizer (totals, filteredTotal, star filters)
src/parsers/stats.ts   Price percentile stats
src/cache.ts           TTL + LRU cache (default 200 entries; search 180s, detail 1800s, taxonomy 86400s) - stores parsed payloads, never raw HTML
src/diskStore.ts       Generic keyed JSON disk cache (taxonomy, per-brand models, probed UA - all inside the profile dir)
src/config.ts          Env-var config (numeric envs validated via numFrom; garbage falls back to defaults)
src/tools/schemas.ts   Zod input AND output schemas (single source of truth for tool contracts)
test/parsers.test.ts   Offline vitest suite over recorded fixtures - keep green, extend when parsers change
test/cache.test.ts     TTL/LRU cache behavior
test/fetcher.test.ts   Serializer (request mutex) behavior
```

## Hard rules

- Never `console.log` / write to **stdout** anywhere in server code - stdout carries the MCP stdio protocol. Log to stderr only.
- Keep requests serialized and slow (~3.5s spacing). Never add concurrency, lower delays, or batch parallel fetches - Cloudflare escalates and IP-blocks. The Fetcher enforces this with an internal promise-queue mutex (`createSerializer`); every new fetch path must go through `enqueue`.
- Use `playwright-core` (not `playwright`) so installs never download browsers. Launch with `channel: "chrome"` against installed Google Chrome; bundled Chromium is fallback only.
- User agent rules: headless launches MUST override the UA (headless browsers advertise "HeadlessChrome/<v>", which Cloudflare hard-blocks) using a version probed from the actual browser (`Fetcher.headlessUserAgent`) so the major stays truthful; headed launches keep the browser's native UA. Never reintroduce a hardcoded stale-version UA.
- The browser profile dir (`~/.cache/chrono24-mcp/profile`) persists the Cloudflare clearance cookie across restarts - do not clear it programmatically or default it to a temp dir.
- Cache parsed payloads, never raw HTML (memory), and never cache failures - `cachedParse` parsers throw (e.g. `NotFoundError`) to keep bad pages out of the cache.
- Tool results must include `structuredContent` matching the tool's output schema in `src/tools/schemas.ts` (the SDK validates non-error results); `ok()` handles this - use it.

## Domain knowledge (learned the hard way)

- Search cards: `div.js-listing-item-container`; title lines `p.text-ellipsis`; price `p.wt-listing-item-price`; image attr is `img[data-lazy-sweet-spot-master-src]` with `_SIZE_` replaced by pixel width. Legacy fallback selector: `a.js-article-item` (old markup era).
- Total result count: parse leaf text nodes matching `N listings/results`. NEVER read JSON-LD `AggregateOffer.offerCount` (counts only the ~60 embedded offers).
- Detail pages: primary source is `<script type="application/ld+json">` Product node (`sku` = reference number, `offers` = price); supplement with the spec table. Neutral URL form `/watches/--id<ID>.htm` redirects to canonical.
- Two distinct dealer ids exist: `dealerId` (`data-dealer-id`, powers ratings via `/api/merchant/ratings.json?dealerId=...`) vs `customerId` (URL param, powers inventory search filter). Never conflate - they are different numbers for the same dealer.
- Dealer ratings JSON is fetched in-page (`page.evaluate(fetch)` with credentials) so it inherits the Cloudflare-cleared cookies; shape: `{dealerRatingModels[], paging{total,filteredTotal,offset}, ratingStarsFilter[]}`. `ratingStarsFilter` holds labels only (no counts); the endpoint accepts `stars=1..5`, but `sorting` only accepts `Relevance` - every other value (Newest/Date/etc.) returns HTTP 400 (probed live 2026-09). `get_dealer_rating_summary` reconstructs the exact star histogram from five per-star `filteredTotal` requests - there is no cheaper aggregate source (detail pages render dealer ratings client-side, and dealer profile pages expose no static aggregate).
- No per-request currency: `currencyId` is dropped in the search redirect and Chrono24 pins currency to the browser session cookie, so a per-request override would silently return the session currency and could flip the session for later calls (verified live 2026-09). Currency stays env-level (`CURRENCY_ID`).
- Price development / trend charts on detail pages are fully client-rendered - no static JSON to parse (probed 2026-09).
- The shipping-country-selector ajax fragment (`/search/detail/shipping-country-selector.htm?ajax=1`) returns only the country picker UI - no shipping costs, even with `&country=XX` (probed 2026-09). Availability + ships-within come from the detail page itself instead.
- Saved searches persist in `<profileDir>/chrono24-saved-searches.json` via diskStore; `check_saved_searches` diffs against per-search seenIds (capped at 600).
- `get_price_stats sample:'spread'` and `find_deals` interpolate population percentiles from first/middle/last price-sorted pages (`estimateStats`); the cheapest-60 sample stays the 1-request default.
- A sold/removed listing serves a page without the JSON-LD Product / spec table (or redirects away from `--id<ID>.htm`); `hasDetailContent` + the finalUrl check turn that into a NotFoundError instead of an empty "success".
- Search URLs redirect to canonical brand/model pages (`/search/index.htm?...` -> `/rolex/submariner--mod1.htm?...`); always parse whatever page lands.
- Pagination: the param is the lowercase `showpage` (Chrono24 ignores `showPage`), and the `/search/index.htm` redirect strips paging params entirely - page N must be requested at the canonical (post-redirect) URL with the original params + `showpage=N` (`pagedSearch` in index.ts does the two-step; verified live 2026-09). Dealer inventory (customerId) does not redirect, but goes through the same path for uniformity.
- There is no working `referenceNumber` URL param (alone it renders a page with zero cards; with a query it is dropped in the redirect and silently returns unfiltered results). References are matched via the free-text `query` - `buildSearchUrl` folds `referenceNumber` into it (verified live 2026-09).
- `list_filters` surfaces every select on the search page, including some that are NOT facet passthrough params (`countryIds` -> `countries` param, `usedOrNew` -> `condition` param). Tool responses annotate `passthrough`/`useInstead`, and search tools report dropped keys in `ignoredFacets` instead of silently unfiltering.
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
