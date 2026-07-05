'use client'

import { useState } from 'react'
import { fmtDate, fmtPct, fmtSigned, fmtUsd, toCsv } from '../lib/format'
import ChartCard from './ChartCard'
import TimeSeriesChart, { ChartEvent } from './charts/TimeSeriesChart'
import StackedAreaChart from './charts/StackedAreaChart'
import DepthTable, { DepthTableRow } from './charts/DepthTable'

// Serializable payload assembled server-side in page.tsx from the metrics layer.

export interface SeriesPointT {
  d: string
  v: number | null
}

export interface AssetSlice {
  volumeShare: { d: string; share: number | null; on: number; off: number }[]
  oiShare: { d: string; share: number | null; on: number; off: number }[]
  funding: {
    d: string
    off: number | null
    on: number | null
    cde: number | null
    kalshi: number | null
    krakenUs: number | null
  }[]
  carry: { d: string; cmeBasis: number | null; offFunding: number | null }[]
  depth: DepthTableRow[]
}

export interface DashboardPayload {
  updated: string
  headline: {
    volumeShare7dPct: number | null
    volumeShareDelta30dPct: number | null
    onshoreOiUsd: number | null
    oiSharePct: number | null
    fundingDivergencePct: number | null
    executionGapBps: number | null
  }
  slices: Record<'ALL' | 'BTC' | 'ETH' | 'SOL' | 'TOTAL', AssetSlice>
  events: { date: string; title: string; description: string; category: string; source: string }[]
  gap: {
    generatedAt: string
    totalUnderlyings: number
    usListedCount: number
    missingVolPct: number
    missingByCategoryUsd: { category: string; usd: number }[]
    topMissing: {
      underlying: string
      category: string
      offshoreVenues: string[]
      offshoreVolumeUsd: number
    }[]
    onshoreOnly: { underlying: string; category: string; onshoreVolumeUsd: number }[]
    all: {
      underlying: string
      category: string
      offshoreVenues: string[]
      onshoreVenues: string[]
      offshoreVolumeUsd: number
    }[]
  }
}

const CATEGORY_LABELS: Record<string, string> = {
  crypto: 'Crypto',
  equity: 'Equity',
  preipo: 'Pre-IPO',
  commodity: 'Commodity',
  index: 'Index',
  fx: 'FX',
}

const ASSET_TABS = ['ALL', 'BTC', 'ETH', 'SOL', 'TOTAL'] as const
type Tab = (typeof ASSET_TABS)[number]

const TAB_LABELS: Record<Tab, string> = {
  ALL: 'Majors (BTC · ETH · SOL)',
  BTC: 'BTC',
  ETH: 'ETH',
  SOL: 'SOL',
  TOTAL: 'Everything listed',
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border-t-2 border-[var(--ink)] pt-2.5">
      <div className="text-[12px] leading-snug text-[var(--ink-2)]">{label}</div>
      <div className="mt-1 text-[26px] font-semibold leading-none tracking-tight text-[var(--ink)]">{value}</div>
      {sub && <div className="mt-1.5 text-[11.5px] text-[var(--ink-3)]">{sub}</div>}
    </div>
  )
}

/** Composition bar shown while an accumulating series has fewer than two observations. */
function FirstDays({
  rows,
}: {
  rows: { d: string; share: number | null; on: number; off: number }[]
}) {
  const latest = rows[rows.length - 1]
  if (!latest) {
    return (
      <div className="rounded border border-[var(--border)] bg-[var(--surface-2)] px-4 py-5 text-[13px] text-[var(--ink-2)]">
        No observations recorded yet — the first daily ingest will populate this series.
      </div>
    )
  }
  const total = latest.on + latest.off
  const onPct = total > 0 ? (latest.on / total) * 100 : 0
  return (
    <div>
      <div className="flex h-9 w-full overflow-hidden rounded-[3px]">
        <div
          className="h-full"
          style={{ width: `${Math.max(onPct, 0.5)}%`, background: 'var(--accent)', opacity: 0.85 }}
        />
        <div className="h-full w-[2px] bg-[var(--surface)]" />
        <div className="h-full flex-1" style={{ background: 'var(--offshore)', opacity: 0.6 }} />
      </div>
      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-[12.5px]">
        <span className="text-[var(--ink-2)]">
          <span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-[2px] align-[-1px]" style={{ background: 'var(--accent)', opacity: 0.85 }} />
          Onshore <span className="tnum font-semibold text-[var(--ink)]">{fmtUsd(latest.on)}</span>{' '}
          <span className="tnum">({onPct.toFixed(1)}%)</span>
        </span>
        <span className="text-[var(--ink-2)]">
          <span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-[2px] align-[-1px]" style={{ background: 'var(--offshore)', opacity: 0.6 }} />
          Offshore <span className="tnum font-semibold text-[var(--ink)]">{fmtUsd(latest.off)}</span>
        </span>
        <span className="text-[var(--ink-3)]">
          {fmtDate(latest.d)} — the timeseries draws itself as daily observations accumulate
        </span>
      </div>
    </div>
  )
}

/**
 * Section 2 on the "Everything listed" tab: what the whole market trades, by
 * category, and how much of each category has any US-regulated listing.
 * Funding/basis/depth are contract-level and stay on the per-asset tabs.
 */
function CategoryComposition({ gap }: { gap: DashboardPayload['gap'] }) {
  const byCat = new Map<string, { listed: number; missing: number }>()
  for (const r of gap.all) {
    if (r.offshoreVolumeUsd <= 0) continue
    const bucket = byCat.get(r.category) ?? { listed: 0, missing: 0 }
    if (r.onshoreVenues.length > 0) bucket.listed += r.offshoreVolumeUsd
    else bucket.missing += r.offshoreVolumeUsd
    byCat.set(r.category, bucket)
  }
  const rows = [...byCat.entries()]
    .map(([category, b]) => ({ category, ...b, total: b.listed + b.missing }))
    .filter((r) => r.total > 1e6)
    .sort((a, b) => b.total - a.total)
  const max = Math.max(...rows.map((r) => r.total), 1)

  return (
    <>
      <SectionHead
        num="2"
        title="What the whole market trades"
        dek="Offshore 24h volume by asset category, split by whether the underlying has any US-regulated listing. Funding, basis and execution are contract-level measures and live on the per-asset tabs; this is the venue-wide counterpart — how much of each category's activity a US-restricted trader can access at all."
      />
      <ChartCard
        num="2.1"
        title="Offshore volume by category: US-listed vs no US listing"
        subtitle={`every listed contract · snapshot ${fmtDate(gap.generatedAt.slice(0, 10))}`}
        note="Blue is offshore volume in underlyings that have at least one CFTC-regulated listing (the market a US trader can reach in regulated form); gray has none. Categories from Binance listing metadata plus documented curated sets — see chart 3.1 and the methodology page."
        csv={{
          filename: 'market-composition.csv',
          build: () =>
            toCsv(
              ['category', 'offshore_vol_us_listed_usd', 'offshore_vol_no_us_listing_usd'],
              rows.map((r) => [r.category, Math.round(r.listed), Math.round(r.missing)])
            ),
        }}
      >
        <div className="space-y-3">
          {rows.map((r) => {
            const listedPct = (r.listed / r.total) * 100
            return (
              <div key={r.category}>
                <div className="mb-1 flex items-baseline justify-between text-[12.5px]">
                  <span className="font-medium text-[var(--ink)]">{CATEGORY_LABELS[r.category] ?? r.category}</span>
                  <span className="tnum text-[var(--ink-2)]">
                    {fmtUsd(r.total)} · <span className="text-[var(--ink-3)]">{listedPct.toFixed(0)}% US-reachable</span>
                  </span>
                </div>
                <div className="flex h-4 overflow-hidden rounded-[2px]" style={{ width: `${(r.total / max) * 100}%`, minWidth: '2%' }}>
                  {r.listed > 0 && (
                    <div style={{ width: `${listedPct}%`, background: 'var(--accent)', opacity: 0.85 }} />
                  )}
                  {r.listed > 0 && r.missing > 0 && <div className="w-[2px] bg-[var(--surface)]" />}
                  {r.missing > 0 && <div className="flex-1" style={{ background: 'var(--offshore)', opacity: 0.6 }} />}
                </div>
              </div>
            )
          })}
          <div className="flex gap-5 pt-1 text-[11.5px] text-[var(--ink-2)]">
            <span>
              <span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-[2px] align-[-1px]" style={{ background: 'var(--accent)', opacity: 0.85 }} />
              Underlying has a US-regulated listing
            </span>
            <span>
              <span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-[2px] align-[-1px]" style={{ background: 'var(--offshore)', opacity: 0.6 }} />
              No US listing
            </span>
          </div>
        </div>
      </ChartCard>
    </>
  )
}

function SectionHead({ num, title, dek }: { num: string; title: string; dek: string }) {
  return (
    <div className="mt-16 border-t border-[var(--border-strong)] pt-5">
      <h2 className="font-serif-display text-[21px] font-semibold text-[var(--ink)]">
        <span className="mr-2.5 text-[var(--ink-3)]">{num}</span>
        {title}
      </h2>
      <p className="mt-1.5 max-w-[640px] text-[13.5px] leading-relaxed text-[var(--ink-2)]">{dek}</p>
    </div>
  )
}

export default function Dashboard({ payload }: { payload: DashboardPayload }) {
  const [tab, setTab] = useState<Tab>('ALL')
  const slice = payload.slices[tab]
  const h = payload.headline

  const chartEvents: ChartEvent[] = payload.events.map((e, i) => ({ date: e.date, n: i + 1, title: e.title }))
  const assetLabel =
    tab === 'ALL' ? 'BTC + ETH + SOL' : tab === 'TOTAL' ? 'every listed contract, all assets' : tab
  // Funding/carry/execution are contract-level measures; the Everything tab
  // shows them for the majors rather than a noise-average over the alt tail
  const premiumLabel = tab === 'TOTAL' ? 'BTC + ETH + SOL' : tab === 'ALL' ? 'BTC + ETH + SOL' : tab

  return (
    <main className="mx-auto max-w-[1080px] px-5">
      {/* Masthead */}
      <div className="pt-12">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-3)]">
          Market structure observatory
        </div>
        <h1 className="font-serif-display mt-2 max-w-[720px] text-[34px] font-semibold leading-[1.15] tracking-tight text-[var(--ink)]">
          Where does crypto derivatives liquidity live?
        </h1>
        <p className="mt-3 max-w-[640px] text-[14.5px] leading-relaxed text-[var(--ink-2)]">
          A daily measurement of how much crypto derivatives trading is migrating from offshore venues to
          CFTC-regulated US exchanges — and what fragmented liquidity still costs US market participants.
          Perpetuals and futures on BTC, ETH and SOL. <strong className="font-medium text-[var(--ink)]">Onshore</strong>{' '}
          comprises the CFTC-regulated markets: CME, Coinbase Derivatives, Kalshi and Kraken&rsquo;s US exchange
          (Bitnomial). <strong className="font-medium text-[var(--ink)]">Offshore</strong> comprises the major
          venues outside US regulation: Binance, Bybit, OKX, Deribit, Hyperliquid and Kraken Futures (non-US).
        </p>
        <div className="mt-3 text-[12px] text-[var(--ink-3)]">
          Data through {fmtDate(payload.updated)} · refreshed daily · all sources public and keyless
        </div>
      </div>

      {/* KPI row */}
      <div className="mt-10 grid grid-cols-2 gap-x-8 gap-y-7 md:grid-cols-4">
        <StatTile
          label="Onshore share of volume"
          value={h.volumeShare7dPct == null ? '—' : fmtPct(h.volumeShare7dPct)}
          sub={
            h.volumeShareDelta30dPct == null
              ? '7-day average'
              : `${fmtSigned(h.volumeShareDelta30dPct, 1, ' pp')} vs 30 days ago · 7-day avg`
          }
        />
        <StatTile
          label="Onshore share of open interest"
          value={h.oiSharePct == null ? '—' : fmtPct(h.oiSharePct)}
          sub="vs Binance, Bybit and OKX"
        />
        <StatTile
          label="Onshore open interest"
          value={h.onshoreOiUsd == null ? '—' : fmtUsd(h.onshoreOiUsd)}
          sub="CFTC weekly + venue-reported daily"
        />
        <StatTile
          label="Funding divergence"
          value={h.fundingDivergencePct == null ? '—' : fmtSigned(h.fundingDivergencePct, 1, ' pp')}
          sub="offshore minus onshore, annualized · 7-day avg"
        />
      </div>

      {/* Asset filter */}
      <div className="mt-12 flex items-center gap-1 border-b border-[var(--border)] pb-0">
        {ASSET_TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px cursor-pointer border-b-2 px-3 pb-2 text-[12.5px] font-medium ${
              tab === t
                ? 'border-[var(--ink)] text-[var(--ink)]'
                : 'border-transparent text-[var(--ink-3)] hover:text-[var(--ink-2)]'
            }`}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
        <span className="ml-auto pb-2 text-[11.5px] text-[var(--ink-3)]">scopes every panel below</span>
      </div>

      {/* ── Section 1: market share ─────────────────────────────── */}
      <SectionHead
        num="1"
        title="Onshore vs offshore market share"
        dek="The share of daily traded volume and open interest sitting on the CFTC-regulated markets versus the offshore aggregate. Venue composition of each group is defined above and on the methodology page."
      />

      <ChartCard
        num="1.1"
        title="Daily traded volume, onshore vs offshore"
        subtitle={`${assetLabel} · perps + futures · 7-day trailing average · numbered flags = section 4`}
        note={
          tab === 'TOTAL'
            ? 'Every listed derivative on all ten venues — crypto majors, the altcoin tail, and equity/pre-IPO/commodity contracts where venues list them. History is reconstructed contract-by-contract from each venue’s daily candles across its current catalog; instruments delisted during the year can’t be enumerated, so older months undercount modestly. Hover for the onshore share.'
            : 'Onshore history covers CME (front-month, via the public delayed feed), Coinbase Derivatives (all currently-listed contracts) and Kalshi from its June 2026 launch; dated CDE contracts that have since expired and CME SOL history are unavailable from free feeds, both small. Hover for the onshore share on any date.'
        }
        csv={{
          filename: `onshore-volume-share-${tab}.csv`,
          build: () =>
            toCsv(
              ['date', 'onshore_share_pct', 'onshore_usd', 'offshore_usd'],
              slice.volumeShare.map((p) => [p.d, p.share, Math.round(p.on), Math.round(p.off)])
            ),
        }}
      >
        {slice.volumeShare.length < 2 ? (
          <FirstDays rows={slice.volumeShare} />
        ) : (
          <StackedAreaChart
            dates={slice.volumeShare.map((p) => p.d)}
            bands={[
              { id: 'on', label: 'Onshore', color: 'var(--accent)' },
              { id: 'off', label: 'Offshore', color: 'var(--offshore-line)' },
            ]}
            values={[slice.volumeShare.map((p) => p.on), slice.volumeShare.map((p) => p.off)]}
            events={chartEvents}
            totalLabel="Total market"
            shareLabel="Onshore share"
          />
        )}
      </ChartCard>

      <ChartCard
        num="1.2"
        title="Open interest, onshore vs offshore"
        subtitle={`${assetLabel} · onshore = CFTC weekly reports + venue-reported daily · offshore = Binance + Bybit + OKX`}
        note={
          tab === 'TOTAL'
            ? 'Venue-wide open interest cannot be reconstructed from candles the way volume can, so this series accumulates from July 3, 2026 (Binance venue-wide OI via CoinGecko, the one non-direct source; the onshore side carries a year of weekly CFTC history immediately).'
            : 'The offshore side is a fixed set — Binance, Bybit and OKX, the three largest — so the series stays comparable across dates. Verified retention: Bybit serves a year+ of OI history, OKX 180 days, Binance only 30 days (the binding constraint on this window); Deribit and Hyperliquid offer no free OI history at all. The window extends daily as snapshots accumulate. Hover for the onshore share.'
        }
        csv={{
          filename: `onshore-oi-share-${tab}.csv`,
          build: () =>
            toCsv(
              ['date', 'onshore_share_pct', 'onshore_usd', 'offshore_usd'],
              slice.oiShare.map((p) => [p.d, p.share, Math.round(p.on), Math.round(p.off)])
            ),
        }}
      >
        {slice.oiShare.length < 2 ? (
          <FirstDays rows={slice.oiShare} />
        ) : (
          <StackedAreaChart
            dates={slice.oiShare.map((p) => p.d)}
            bands={[
              { id: 'on', label: 'Onshore', color: 'var(--accent)' },
              { id: 'off', label: 'Offshore', color: 'var(--offshore-line)' },
            ]}
            values={[slice.oiShare.map((p) => p.on), slice.oiShare.map((p) => p.off)]}
            totalLabel="Total open interest"
            shareLabel="Onshore share"
          />
        )}
      </ChartCard>

      {/* ── Section 2: onshore premium (per-asset) OR market composition (Everything) ── */}
      {tab === 'TOTAL' ? (
        <CategoryComposition gap={payload.gap} />
      ) : (
        <>
      <SectionHead
        num="2"
        title="The onshore premium"
        dek="What fragmented liquidity costs a US trader: the gap between offshore and onshore funding rates, the carry embedded in CME's futures basis, and the real cost of executing size. These are contract-level measures — averaging funding or depth across hundreds of thin alt contracts would be noise — so this section shows the majors (or the single asset selected above)."
      />

      <ChartCard
        num="2.1"
        title="Perp funding rates, onshore vs offshore"
        subtitle={`${premiumLabel} · funding annualized, 7-day average · equal-weight composite within each group`}
        note="How to read this: funding is the recurring fee perp longs pay shorts (negative = shorts pay longs), expressed as a yearly cost of holding the position. Each line is one group's average; the shaded band between them is the onshore premium — when the gray offshore line sits above the blue onshore line, the same long position costs more to hold offshore. The onshore composite runs from Coinbase Derivatives' July 2025 perp launch: its pre-July-2026 funding is reconstructed from the perp–spot premium using Coinbase's published funding formula (rows labeled in the dataset, method on the methodology page); Kalshi and Kraken US join at their 2026 launches with venue-published rates. The late-May bump is a real launch-week dislocation on Kraken US, verified against the exchange's raw feed."
        csv={{
          filename: `funding-divergence-${tab}.csv`,
          build: () =>
            toCsv(
              [
                'date',
                'offshore_composite_7d_pct_pa',
                'onshore_composite_7d_pct_pa',
                'coinbase_derivatives_daily_pct_pa',
                'kalshi_daily_pct_pa',
                'kraken_us_daily_pct_pa',
              ],
              slice.funding.map((p) => [p.d, p.off, p.on, p.cde, p.kalshi, p.krakenUs])
            ),
        }}
      >
        <TimeSeriesChart
          yFmt="pctPa"
          zeroLine
          fillBetween={['off', 'on']}
          series={[
            {
              id: 'off',
              label: 'Offshore composite',
              color: 'var(--offshore-line)',
              context: true,
              points: slice.funding.map((p) => ({ d: p.d, v: p.off })),
            },
            {
              id: 'on',
              label: 'Onshore composite',
              short: 'Onshore',
              color: 'var(--accent)',
              points: slice.funding.map((p) => ({ d: p.d, v: p.on })),
            },
          ]}
        />
      </ChartCard>

      <ChartCard
        num="2.2"
        title="Cost of carry: onshore futures basis vs offshore perp funding"
        subtitle={`${premiumLabel === 'BTC + ETH + SOL' ? 'BTC + ETH' : premiumLabel} · both annualized and 7-day averaged, so the two carry measures are directly comparable`}
        note="The onshore line is CME's front-month basis — the regulated market's implied cost of carry; offshore perp funding is the same quantity paid continuously. Convergence of these lines is capital-market integration in one picture. Expiry is approximated as the last Friday of the month, rolling ten days out."
        csv={{
          filename: `carry-comparison-${tab}.csv`,
          build: () =>
            toCsv(
              ['date', 'cme_basis_pct_pa', 'offshore_funding_pct_pa'],
              slice.carry.map((p) => [p.d, p.cmeBasis, p.offFunding])
            ),
        }}
      >
        <TimeSeriesChart
          yFmt="pctPa"
          zeroLine
          series={[
            {
              id: 'cme',
              label: 'Onshore futures carry (CME basis)',
              short: 'Onshore',
              color: 'var(--accent)',
              points: slice.carry.map((p) => ({ d: p.d, v: p.cmeBasis })),
            },
            {
              id: 'offf',
              label: 'Offshore perp funding',
              color: 'var(--offshore-line)',
              context: true,
              points: slice.carry.map((p) => ({ d: p.d, v: p.offFunding })),
            },
          ]}
        />
      </ChartCard>

      <ChartCard
        num="2.3"
        title="Execution quality, onshore vs offshore"
        subtitle={`${tab === 'ALL' ? 'BTC' : tab} · latest order-book snapshots · best available book in each group; depth summed across the group`}
        note="Assumes a trader routes to the best book on their side of the fence. Onshore books observed: Coinbase Derivatives and Kalshi (CME and Kraken US publish no free depth feed). Offshore books: Binance, Bybit, OKX, Deribit, Hyperliquid and Kraken Futures. Kalshi and Coinbase Derivatives books are converted to implied coin prices via contract size."
        csv={{
          filename: `execution-quality-${tab === 'ALL' ? 'BTC' : tab}.csv`,
          build: () =>
            toCsv(
              ['group', 'best_spread_bps', 'best_cost_100k_bps', 'best_cost_1m_bps', 'total_depth_50bps_usd'],
              slice.depth.map((r) => [
                r.venueName,
                r.spreadBps,
                r.cost100k,
                r.cost1m,
                Math.round(r.depth50BpsUsd),
              ])
            ),
        }}
      >
        <DepthTable rows={slice.depth} />
      </ChartCard>
        </>
      )}

      {/* ── Section 3: the listing gap ───────────────────────────── */}
      <SectionHead
        num="3"
        title="The listing gap"
        dek={`Inferred programmatically from every venue's live contract catalog: ${payload.gap.totalUnderlyings.toLocaleString()} underlyings trade as perps or futures on the offshore venues, and only ${payload.gap.usListedCount} of them have any US-regulated listing. Contracts with no onshore venue carried ${fmtPct(payload.gap.missingVolPct)} of offshore volume over the past day — ${payload.gap.missingByCategoryUsd
          .filter((c) => c.usd > 1e8 && c.category !== 'crypto')
          .map((c) => `${fmtUsd(c.usd)} of it in ${CATEGORY_LABELS[c.category].toLowerCase()} perps`)
          .join(', ')} that simply do not exist on a CFTC-regulated exchange.`}
      />

      <ChartCard
        num="3.1"
        title="Largest offshore markets with no US-regulated listing"
        subtitle={`by 24h offshore volume · snapshot ${fmtDate(payload.gap.generatedAt.slice(0, 10))}`}
        note="Underlyings are normalized across venues (1000PEPE/kPEPE→PEPE, XBT→BTC) and classified with Binance's own listing metadata (equity, pre-IPO, commodity, index) plus documented curated sets for what Binance doesn't list. Full inventory in the CSV and /data/listing_gap.json."
        csv={{
          filename: 'listing-gap.csv',
          build: () =>
            toCsv(
              ['underlying', 'category', 'offshore_venues', 'onshore_venues', 'offshore_volume_24h_usd'],
              payload.gap.all.map((r) => [
                r.underlying,
                r.category,
                r.offshoreVenues.join('; '),
                r.onshoreVenues.join('; '),
                Math.round(r.offshoreVolumeUsd),
              ])
            ),
        }}
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-[var(--border-strong)] text-left text-[11px] uppercase tracking-wider text-[var(--ink-3)]">
                <th className="py-2 pr-3 font-medium">Underlying</th>
                <th className="py-2 pr-3 font-medium">Category</th>
                <th className="py-2 pr-3 font-medium">Offshore venues</th>
                <th className="py-2 text-right font-medium">24h offshore volume</th>
              </tr>
            </thead>
            <tbody>
              {payload.gap.topMissing.map((r) => (
                <tr key={r.underlying} className="border-b border-[var(--border)]">
                  <td className="py-2 pr-3 font-medium text-[var(--ink)]">{r.underlying}</td>
                  <td className="py-2 pr-3">
                    <span
                      className={`rounded-sm px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-wide ${
                        r.category === 'crypto'
                          ? 'bg-[var(--surface-2)] text-[var(--ink-2)]'
                          : 'bg-[#efe9fb] text-[#4a3aa7]'
                      }`}
                    >
                      {CATEGORY_LABELS[r.category] ?? r.category}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-[var(--ink-2)]">{r.offshoreVenues.join(', ')}</td>
                  <td className="tnum py-2 text-right text-[var(--ink)]">{fmtUsd(r.offshoreVolumeUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ChartCard>

      {payload.gap.onshoreOnly.length > 0 && (
        <p className="mt-5 max-w-[720px] text-[13px] leading-relaxed text-[var(--ink-2)]">
          The gap runs the other way too:{' '}
          {payload.gap.onshoreOnly
            .slice(0, 6)
            .map((r) => `${r.underlying} (${fmtUsd(r.onshoreVolumeUsd)})`)
            .join(', ')}{' '}
          trade only on US-regulated venues — Coinbase Derivatives&rsquo; commodity and sector-index futures have
          no offshore twin.
        </p>
      )}

      {/* ── Section 4: regulatory timeline ───────────────────────── */}
      <SectionHead
        num="4"
        title="Regulatory timeline"
        dek="The dated approvals, launches and rule changes that move the charts above. Numbers match the flags on chart 1.1."
      />
      <ol className="mt-6 space-y-0">
        {payload.events.map((e, i) => (
          <li key={e.date + e.title} className="flex gap-4 border-b border-[var(--border)] py-3.5">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--border-strong)] bg-[var(--surface-2)] text-[10.5px] font-semibold text-[var(--ink-2)]">
              {i + 1}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span className="tnum text-[12px] font-medium text-[var(--ink-3)]">{fmtDate(e.date)}</span>
                <span className="text-[13.5px] font-semibold text-[var(--ink)]">{e.title}</span>
                <span className="text-[10.5px] uppercase tracking-wider text-[var(--ink-3)]">{e.category}</span>
              </div>
              <p className="mt-1 max-w-[640px] text-[13px] leading-relaxed text-[var(--ink-2)]">
                {e.description}{' '}
                <a
                  href={e.source}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--ink-3)] underline decoration-[var(--border-strong)] underline-offset-2 hover:text-[var(--ink-2)]"
                >
                  source
                </a>
              </p>
            </div>
          </li>
        ))}
      </ol>
    </main>
  )
}
