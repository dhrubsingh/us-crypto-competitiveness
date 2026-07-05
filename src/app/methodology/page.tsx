import type { Metadata } from 'next'
import { VENUES, VENUE_IDS } from '../../lib/observatory/types'

export const metadata: Metadata = { title: 'Methodology — US Crypto Derivatives Observatory' }
export const dynamic = 'force-static'

const H2 = ({ children }: { children: React.ReactNode }) => (
  <h2 className="font-serif-display mt-12 text-[20px] font-semibold text-[var(--ink)]">{children}</h2>
)
const P = ({ children }: { children: React.ReactNode }) => (
  <p className="mt-3 text-[14px] leading-[1.75] text-[var(--ink-2)]">{children}</p>
)

export default function Methodology() {
  return (
    <main className="mx-auto max-w-[760px] px-5 pt-12">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-3)]">Methodology</div>
      <h1 className="font-serif-display mt-2 text-[30px] font-semibold leading-tight text-[var(--ink)]">
        Sources, definitions and known limitations
      </h1>
      <P>
        This page is the contract behind every number on the dashboard. All sources are public and require no
        API keys, so anyone can reproduce the dataset from the open-source pipeline. Where a metric involves a
        judgment call, the call and its consequences are stated here.
      </P>

      <H2>Scope</H2>
      <P>
        The observatory tracks perpetual futures and dated futures on BTC, ETH and SOL, plus an
        &ldquo;everything listed&rdquo; series covering every derivative contract on the tracked venues — the
        altcoin tail and RWA, equity-index and commodity contracts included. Options are excluded in this
        version. <strong className="text-[var(--ink)]">Onshore</strong> means a CFTC-registered designated
        contract market: CME, Coinbase Derivatives Exchange (CDE), Kalshi, and Kraken&rsquo;s US exchange —
        Bitnomial, the CFTC DCM/DCO acquired by Kraken&rsquo;s parent in April 2026, whose perpetual contracts
        trade through Kraken Pro. <strong className="text-[var(--ink)]">Offshore</strong> covers the major
        venues serving the global market outside US regulation: Binance, Bybit, OKX, Deribit, Hyperliquid, and
        Kraken Futures (Crypto Facilities, the separate non-US Kraken entity closed to US persons — distinct
        from Kraken&rsquo;s onshore exchange above). Cboe wound down its digital-asset futures business and is
        not tracked. In CFTC reports, &ldquo;LMX Labs, LLC&rdquo; is Coinbase Derivatives&rsquo; former legal
        name; both names are merged into CDE.
      </P>

      <H2>Per-venue sources</H2>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-[var(--border-strong)] text-left text-[11px] uppercase tracking-wider text-[var(--ink-3)]">
              <th className="py-2 pr-3 font-medium">Venue</th>
              <th className="py-2 pr-3 font-medium">Region</th>
              <th className="py-2 pr-3 font-medium">Volume</th>
              <th className="py-2 font-medium">Open interest</th>
            </tr>
          </thead>
          <tbody>
            {VENUE_IDS.map((id) => {
              const v = VENUES[id]
              return (
                <tr key={id} className="border-b border-[var(--border)] align-top">
                  <td className="py-2.5 pr-3 font-medium text-[var(--ink)]">{v.name}</td>
                  <td className="py-2.5 pr-3 text-[var(--ink-2)]">{v.region === 'onshore' ? 'US / CFTC' : 'Offshore'}</td>
                  <td className="py-2.5 pr-3 text-[var(--ink-2)]">{v.volumeSource}</td>
                  <td className="py-2.5 text-[var(--ink-2)]">{v.oiSource}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <P>
        Binance and Bybit geo-block US IP addresses. Live reads are made directly from the deployed
        application, which runs in an EU region; historical Binance data comes from Binance&rsquo;s public
        archive CDN, which is not geo-restricted. No credentialed or private access is used anywhere.
      </P>

      <H2>Metric definitions</H2>
      <P>
        <strong className="text-[var(--ink)]">Venue-wide totals (&ldquo;everything listed&rdquo;).</strong>{' '}
        Volume sums every listed contract per venue from bulk public endpoints (Binance/Bybit/OKX/Kraken
        tickers, Deribit book summaries, Hyperliquid asset contexts, the Coinbase/Kalshi/Bitnomial catalogs,
        CME&rsquo;s crypto suite on the delayed feed). Open interest likewise, with one exception: Binance has
        no bulk OI endpoint, so its venue-wide OI comes from CoinGecko&rsquo;s Binance Futures page — the only
        non-direct source in the observatory. Onshore venue-wide OI adds the CFTC-reported XRP and BCH
        contracts to the majors. Venue-wide volume <em>history</em> is reconstructed contract-by-contract from
        each venue&rsquo;s daily candle feeds across its current catalog (instruments delisted during the year
        cannot be enumerated, so older months undercount modestly); venue-wide OI history cannot be
        reconstructed this way and accumulates from July 3, 2026.
      </P>
      <P>
        <strong className="text-[var(--ink)]">Onshore share of volume.</strong> Onshore ÷ (onshore + offshore)
        daily USD notional, summed across tracked contracts per asset, presented as a 7-day trailing average.
        Offshore venue volume is the venue-reported 24-hour notional for the tracked perp (all listed futures
        for Deribit); CME volume is front-month standard + micro contracts × contract size × settlement price;
        CDE volume sums every listed contract × contract size × price; Kalshi is venue-reported notional.
      </P>
      <P>
        <strong className="text-[var(--ink)]">Onshore share of open interest.</strong> Onshore OI uses the
        CFTC&rsquo;s weekly Commitments of Traders reports (all CME and CDE crypto contracts, dollarized at the
        spot close on the report date, forward-filled between reports) plus Kalshi&rsquo;s daily reported OI.
        The offshore denominator is a fixed set — Binance, Bybit and OKX, the three largest — because Deribit
        and Hyperliquid publish no OI history and letting venues drift in and out of the denominator would
        fabricate share moves. Their OI is still collected daily and reported in the dataset; the headline
        share is modestly overstated as a result (both are small relative to the trio).
      </P>
      <P>
        <strong className="text-[var(--ink)]">Funding rates.</strong> All funding is normalized to an
        8-hour-equivalent rate, then annualized (×3 ×365) for display. Daily values are the mean of the
        day&rsquo;s funding periods. Each composite is an equal-weight mean of its group&rsquo;s available
        venues — offshore: Binance, Bybit, OKX, Deribit, Hyperliquid, Kraken Futures; onshore: CDE, Kalshi,
        Kraken US. Hourly funders (Hyperliquid, CDE) are scaled by interval; 8-hour funders are used as
        published. Composites are displayed as 7-day trailing averages (a single 8-hour print, annualized,
        would otherwise dominate the chart); per-venue daily series remain in the raw dataset and CSVs.
      </P>
      <P>
        <strong className="text-[var(--ink)]">CDE funding reconstruction.</strong> Coinbase Derivatives
        publishes no funding-rate history, but it publishes the mechanism: the hourly rate is the hour&rsquo;s
        average perp–spot premium scaled down by 24, EMA-smoothed. Pre-July-2026 CDE funding is therefore
        reconstructed from hourly candle closes — hourly premium = (perp close − spot close) ÷ spot close,
        daily mean ÷ 3 = the 8-hour-equivalent rate — sampling hourly where Coinbase samples every three
        minutes, with prints more than 1% from spot discarded as stale. Validated against observed funding on
        overlapping days (same order of magnitude and sign). These rows carry
        source&nbsp;<span className="font-mono text-[13px]">premium-reconstruction</span> in the dataset and are
        estimates, not exchange-published rates; funding observed live at ingest always takes precedence.
      </P>
      <P>
        <strong className="text-[var(--ink)]">CME basis.</strong> (Front-month close − spot close) ÷ spot,
        annualized by days to expiry, where expiry is approximated as the last Friday of the contract month
        and the series rolls to the next month inside ten days of expiry (annualizing over a near-zero window
        would amplify close-timing noise). Spot reference is Coinbase Exchange; displayed as a 7-day average.
        This is comparable to annualized perp funding as a cost-of-carry measure.
      </P>
      <P>
        <strong className="text-[var(--ink)]">Execution cost.</strong> From full order-book snapshots taken
        at ingest: one-way cost versus mid, in basis points, of a simulated market order of $100K and $1M
        notional walking the book, plus quoted spread and resting depth within ±50 bps of mid. The dashboard
        presents each group&rsquo;s <em>best</em> book (the venue a cost-sensitive trader would route to) and
        the group&rsquo;s summed depth; per-venue snapshots are in the raw dataset. Contract-unit books (CDE,
        Kalshi) are converted to implied coin prices via contract size.
      </P>

      <H2>The listing gap</H2>
      <P>
        Each venue&rsquo;s live contract catalog is enumerated daily (Binance exchangeInfo, Bybit/OKX/Kraken
        tickers, Deribit book summaries, Hyperliquid asset metadata, the Coinbase, Kalshi and Bitnomial product
        catalogs, and a curated CME list). Symbols are normalized to one underlying per asset
        (1000PEPE/kPEPE→PEPE, XBT→BTC) and classified using Binance&rsquo;s own listing metadata — underlying
        type COIN, EQUITY, KR_EQUITY, PREMARKET, COMMODITY or INDEX — with curated fallbacks for what Binance
        doesn&rsquo;t list (Kraken&rsquo;s X-suffixed tokenized equities, FX pairs, CDE&rsquo;s commodity and
        sector-index roots). An underlying counts as &ldquo;missing onshore&rdquo; when no CFTC-regulated venue
        lists any derivative on it. Classification of symbols listed nowhere on Binance falls back to
        heuristics and defaults to crypto; the full inventory is exported for audit.
      </P>

      <H2>Known limitations</H2>
      <ul className="mt-3 list-disc space-y-2 pl-5 text-[14px] leading-[1.7] text-[var(--ink-2)]">
        <li>
          Coinbase Derivatives volume history comes from daily candles for every currently-listed contract
          (the perp-style contract, most of CDE volume, is complete from its July 2025 listing). Coinbase
          stops serving a contract&rsquo;s candles once it expires, so dated contracts that expired during the
          past year are missing from older months — a modest understatement. CDE funding has no public
          history and is observed from July 2026. Its open interest history is complete via CFTC reports.
        </li>
        <li>
          CME volume counts front-month standard and micro contracts only (back months excluded), and the
          public delayed feed carries no history for SOL futures — CME SOL volume accumulates from July 2026.
          CME options are excluded entirely.
        </li>
        <li>
          Offshore volume tracks the dominant USDT-margined perp per venue (plus Deribit&rsquo;s full futures
          complex); coin-margined and exotic-margin contracts are excluded, which understates offshore totals
          somewhat — a conservative bias for the onshore-share thesis.
        </li>
        <li>
          Offshore OI history retention (verified against each API): Bybit serves a year+, OKX 180 days,
          Binance only 30 days — the binding constraint on the OI-share window, which grows one day per day as
          the pipeline accumulates snapshots. Deribit exposes no OI-history endpoint, and Hyperliquid&rsquo;s
          only historical OI archive is a requester-pays S3 bucket, i.e. not freely public.
        </li>
        <li>
          Order-book snapshots are point-in-time, once daily; they are indicative of relative depth, not a
          volume-weighted average. Hyperliquid&rsquo;s API returns 20 aggregated levels, which can understate
          its depth at the $1M tier. CME depth requires a paid feed and Kraken US publishes no free depth
          feed, so the onshore group&rsquo;s books are CDE and Kalshi only.
        </li>
        <li>
          Kraken US (Bitnomial) publishes prices in scaled exchange points, so its open interest is
          dollarized with the observatory&rsquo;s spot reference; its volume and OI history begin at
          observatory launch, and it is below the CFTC&rsquo;s weekly reporting threshold as of mid-2026.
        </li>
        <li>
          The 24-hour volumes read at ingest are rolling windows attributed to the UTC ingest date; venue
          UTC-day candles are used for history where available, so a small boundary mismatch exists on the
          most recent day.
        </li>
      </ul>

      <H2>Citing this data</H2>
      <P>
        Every chart has a CSV download and every underlying dataset is a flat JSON file under{' '}
        <a href="/data" className="underline decoration-[var(--border-strong)] underline-offset-2">/data</a>.
        Cite as &ldquo;US Crypto Derivatives Market Structure Observatory&rdquo; with the dataset date. The
        pipeline and site are open source under the MIT license.
      </P>
    </main>
  )
}
