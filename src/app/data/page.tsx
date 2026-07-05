import type { Metadata } from 'next'
import { loadObservatory } from '../../lib/observatory/metrics'
import { fmtDate } from '../../lib/format'

export const metadata: Metadata = { title: 'Data — US Crypto Derivatives Observatory' }
export const dynamic = 'force-static'

interface DatasetInfo {
  file: string
  name: string
  description: string
  rows: number
}

export default function DataPage() {
  const data = loadObservatory()

  const datasets: DatasetInfo[] = [
    {
      file: 'volume_daily.json',
      name: 'Daily volume',
      description: 'USD notional traded per venue per asset per UTC day, 12-month backfill where sources allow.',
      rows: data.volume.length,
    },
    {
      file: 'oi_daily.json',
      name: 'Daily open interest',
      description: 'USD open interest per venue per asset (venue-reported; history depth varies by venue).',
      rows: data.oi.length,
    },
    {
      file: 'funding_daily.json',
      name: 'Daily funding',
      description: 'Daily mean perp funding per venue per asset, normalized to the 8-hour-equivalent rate in percent.',
      rows: data.funding.length,
    },
    {
      file: 'volume_total_daily.json',
      name: 'Venue-wide daily volume',
      description:
        'USD notional across every listed contract per venue ("everything listed" scope), accumulating from July 2026.',
      rows: data.volumeTotal.length,
    },
    {
      file: 'oi_total_daily.json',
      name: 'Venue-wide daily open interest',
      description:
        'USD open interest across every listed contract per venue (Binance via CoinGecko — the one non-direct source).',
      rows: data.oiTotal.length,
    },
    {
      file: 'oi_total_weekly_onshore.json',
      name: 'Onshore venue-wide OI, weekly',
      description: 'CFTC-reported open interest totals per US exchange, majors plus XRP/BCH contracts, dollarized.',
      rows: data.oiTotalWeeklyOnshore.length,
    },
    {
      file: 'cftc_oi_weekly.json',
      name: 'CFTC weekly open interest',
      description:
        'Weekly Commitments of Traders open interest for every CME and Coinbase Derivatives crypto contract, in contracts and USD.',
      rows: data.cftc.length,
    },
    {
      file: 'basis_daily.json',
      name: 'Daily basis',
      description: 'CME front-month annualized basis vs spot, plus perp premium snapshots per venue.',
      rows: data.basis.length,
    },
    {
      file: 'depth_daily.json',
      name: 'Order-book depth snapshots',
      description: 'Daily spread, $100K/$1M simulated fill cost and ±50 bps resting depth per venue per asset.',
      rows: data.depth.length,
    },
    {
      file: 'listing_gap.json',
      name: 'Listing gap inventory',
      description:
        'Every underlying with a derivative listing on any tracked venue: category, venues on each side, 24h volumes.',
      rows: data.listingGap?.rows.length ?? 0,
    },
    {
      file: 'events.json',
      name: 'Regulatory events',
      description: 'Hand-curated, dated and sourced regulatory approvals, launches and rule changes.',
      rows: data.events.length,
    },
    {
      file: 'meta.json',
      name: 'Pipeline metadata',
      description: 'Last ingest date and per-source freshness.',
      rows: 1,
    },
  ]

  return (
    <main className="mx-auto max-w-[760px] px-5 pt-12">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-3)]">Data</div>
      <h1 className="font-serif-display mt-2 text-[30px] font-semibold leading-tight text-[var(--ink)]">
        The full dataset, as flat files
      </h1>
      <p className="mt-3 text-[14px] leading-[1.75] text-[var(--ink-2)]">
        Everything the dashboard renders is generated from the JSON files below — there is no hidden database.
        Each file is a flat array of rows, stable in schema, refreshed daily, and directly linkable for
        citation. Current through {fmtDate(data.meta?.lastIngestDate ?? '')}.
      </p>

      <ul className="mt-8">
        {datasets.map((d) => (
          <li key={d.file} className="border-b border-[var(--border)] py-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <a
                href={`/data/${d.file}`}
                className="font-mono text-[13.5px] font-medium text-[var(--accent)] hover:underline"
              >
                /data/{d.file}
              </a>
              <span className="tnum text-[12px] text-[var(--ink-3)]">
                {d.rows.toLocaleString()} {d.rows === 1 ? 'row' : 'rows'}
              </span>
            </div>
            <p className="mt-1 text-[13px] leading-relaxed text-[var(--ink-2)]">
              <span className="font-medium text-[var(--ink)]">{d.name}.</span> {d.description}
            </p>
          </li>
        ))}
      </ul>

      <p className="mt-8 text-[13px] leading-relaxed text-[var(--ink-3)]">
        Per-chart CSV exports are available from the download links beside each chart on the dashboard.
        Definitions and caveats for every field are on the methodology page.
      </p>
    </main>
  )
}
