# US Crypto Derivatives Market Structure Observatory

A public dashboard and open data pipeline measuring, in one canonical place, how much crypto
derivatives liquidity is migrating from offshore venues to CFTC-regulated US exchanges — and
quantifying what fragmented liquidity costs US market participants.

**Why this exists (the policy frame):** for a decade, the deepest crypto derivatives markets have
lived offshore, outside US regulatory reach and closed to US participants. A sequence of CFTC
actions — Coinbase Derivatives' perpetual-style futures (July 2025), CME's move to 24/7 trading
(May 2026), the approval of Kalshi's BTCPERP, the first true US perpetual (May 2026) — is testing
whether that liquidity can be brought onshore into regulated venues. This project measures whether
it is actually happening: market share, the "onshore premium" (funding divergence, basis, execution
cost), and the regulatory events that move both.

## Architecture

```
pipeline/            TypeScript ingestion (run with npm scripts, no keys required)
  ingest.ts          daily snapshot: volume, OI, funding, order-book depth, basis, CFTC refresh
  backfill.ts        idempotent 12-month historical backfill where sources allow
  smoke.ts           one-line-per-venue live sanity check
src/lib/observatory/ venue clients + metrics layer (shared by pipeline and site)
public/data/*.json   the canonical datasets — flat files, committed, directly linkable
src/app/             Next.js site: dashboard, /methodology, /data
```

- **Venues:** Binance, Bybit, OKX, Deribit, Hyperliquid (offshore); CME, Coinbase Derivatives,
  Kalshi (onshore). Assets: BTC, ETH, SOL. Perps + futures (options deferred).
- **Onshore OI** comes from the CFTC's weekly Commitments of Traders public API — a citable,
  government source covering every CME and Coinbase Derivatives crypto contract.
- **Geo-blocked venues** (Binance, Bybit) are read via the deployed app's `/api/proxy` route,
  which runs in an EU Vercel region (`vercel.json` pins `fra1`); Binance history comes from its
  public archive CDN, which is not geo-restricted.
- Ingest failures never break the site: the dashboard renders from the last committed snapshot.

## Running it

```bash
npm install
npm run smoke       # live check of every venue client
npm run backfill    # 12-month history (idempotent; --only binance,okx to scope)
npm run ingest      # today's snapshot (idempotent per UTC day)
npm run dev         # dashboard on localhost:3000
```

Daily refresh = `npm run ingest` + commit + deploy (a GitHub Actions cron can wire this up
once the repo is hosted on GitHub; the ingest itself needs nothing but Node).

## Data

Every chart has a CSV download; the full datasets live under `/data` as flat JSON with stable
schemas. Sources, definitions and known limitations are documented on the methodology page —
read it before citing.

MIT licensed. Not investment advice.
