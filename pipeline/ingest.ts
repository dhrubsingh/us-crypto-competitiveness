// Daily ingest: snapshot every venue × asset, append today's rows to the
// datasets, refresh the trailing CFTC weekly OI, and stamp meta.json.
// Idempotent — re-running on the same UTC date overwrites that date's rows.
// A failing venue never aborts the run; it's recorded in meta.sources.

import { ASSETS, Asset, VenueId, DatasetMeta, VolumeRow, OiRow, FundingRow, DepthRow, BasisRow, CftcOiRow, TotalRow } from '../src/lib/observatory/types'
import { VenueSnapshot, fillCostBps, depthWithinBps } from '../src/lib/observatory/sources/common'
import { utcDate } from '../src/lib/observatory/fetch'
import { binanceSnapshot } from '../src/lib/observatory/sources/binance'
import { bybitSnapshot } from '../src/lib/observatory/sources/bybit'
import { okxSnapshot } from '../src/lib/observatory/sources/okx'
import { deribitSnapshot } from '../src/lib/observatory/sources/deribit'
import { hyperliquidSnapshot } from '../src/lib/observatory/sources/hyperliquid'
import { krakenSnapshot } from '../src/lib/observatory/sources/kraken'
import { cmeSnapshot, cmeFrontMonthClose } from '../src/lib/observatory/sources/cme'
import { cdeSnapshot } from '../src/lib/observatory/sources/cde'
import { kalshiSnapshot } from '../src/lib/observatory/sources/kalshi'
import { krakenUsSnapshot } from '../src/lib/observatory/sources/krakenus'
import { cftcOiHistory } from '../src/lib/observatory/sources/cftc'
import { allVenueTotals, cftcExtraOi } from '../src/lib/observatory/sources/totals'
import { buildListingGap } from '../src/lib/observatory/sources/listings'
import { spotPrice, spotCloseHistory } from '../src/lib/observatory/sources/spot'
import { readRows, upsertRows, writeJson } from './store'

type SnapshotFn = (asset: Asset) => Promise<VenueSnapshot | null>

const SNAPSHOTS: Record<VenueId, SnapshotFn> = {
  binance: binanceSnapshot,
  bybit: bybitSnapshot,
  okx: okxSnapshot,
  deribit: deribitSnapshot,
  hyperliquid: hyperliquidSnapshot,
  kraken: krakenSnapshot,
  cme: cmeSnapshot,
  cde: cdeSnapshot,
  kalshi: kalshiSnapshot,
  kraken_us: krakenUsSnapshot,
}

/**
 * CME BTC/ETH/SOL futures expire the last Friday of the contract month; roll
 * to the next month inside 10 days of expiry (same rule as the backfill) so
 * the annualization window never collapses toward zero.
 */
function daysToFrontExpiry(now: Date): number {
  const lastFriday = (y: number, m: number) => {
    const d = new Date(Date.UTC(y, m + 1, 0)) // last day of month
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 2) % 7))
    return d
  }
  let exp = lastFriday(now.getUTCFullYear(), now.getUTCMonth())
  if (exp.getTime() - now.getTime() < 10 * 86_400_000) {
    exp = lastFriday(now.getUTCFullYear(), now.getUTCMonth() + 1)
  }
  return (exp.getTime() - now.getTime()) / 86_400_000
}

async function main() {
  const date = utcDate()
  const now = Date.now()
  const sources: DatasetMeta['sources'] = {}

  const volumes: VolumeRow[] = []
  const ois: OiRow[] = []
  const fundings: FundingRow[] = []
  const depths: DepthRow[] = []
  const bases: BasisRow[] = []

  const spot: Partial<Record<Asset, number>> = {}
  for (const asset of ASSETS) {
    try {
      spot[asset] = await spotPrice(asset)
    } catch (err) {
      console.error(`[spot] ${asset}: ${err}`)
    }
  }

  for (const [venue, snapshotFn] of Object.entries(SNAPSHOTS) as [VenueId, SnapshotFn][]) {
    let ok = 0
    for (const asset of ASSETS) {
      try {
        const snap = await snapshotFn(asset)
        if (!snap) continue
        ok++
        const source = 'live-api'
        if (snap.volumeUsd24h != null)
          volumes.push({ date, venue, asset, volumeUsd: snap.volumeUsd24h, source })
        if (snap.oiUsd != null) ois.push({ date, venue, asset, oiUsd: snap.oiUsd, source })
        if (snap.rate8hPct != null)
          fundings.push({ date, venue, asset, rate8hPct: snap.rate8hPct, source })

        if (snap.book && snap.book.bids.length && snap.book.asks.length) {
          const mid = (snap.book.bids[0][0] + snap.book.asks[0][0]) / 2
          depths.push({
            date,
            timestamp: now,
            venue,
            asset,
            midPrice: mid,
            spreadBps: ((snap.book.asks[0][0] - snap.book.bids[0][0]) / mid) * 10_000,
            fillCost100kBps: fillCostBps(snap.book.asks, mid, 100_000),
            fillCost1mBps: fillCostBps(snap.book.asks, mid, 1_000_000),
            depth50BpsUsd: depthWithinBps(snap.book, mid, 50),
          })
        }

        const s = spot[asset]
        if (s && snap.markPrice && venue !== 'cme') {
          bases.push({
            date,
            venue,
            asset,
            instrument: snap.instrument ?? venue,
            markPrice: snap.markPrice,
            spotPrice: s,
            // perp premium is instantaneous; store un-annualized percent
            basisAnnualizedPct: ((snap.markPrice - s) / s) * 100,
            kind: 'perp',
          })
        }
      } catch (err) {
        console.error(`[${venue}] ${asset}: ${err instanceof Error ? err.message : err}`)
      }
    }
    sources[venue] = { lastSuccess: ok > 0 ? new Date().toISOString() : null }
  }

  // CME basis: front-month close vs spot, annualized to expiry
  for (const asset of ASSETS) {
    const s = spot[asset]
    if (!s) continue
    try {
      const front = await cmeFrontMonthClose(asset)
      if (front) {
        const dte = daysToFrontExpiry(new Date())
        bases.push({
          date,
          venue: 'cme',
          asset,
          instrument: 'front-month',
          markPrice: front,
          spotPrice: s,
          basisAnnualizedPct: ((front - s) / s) * (365 / dte) * 100,
          kind: 'future',
        })
      }
    } catch (err) {
      console.error(`[cme-basis] ${asset}: ${err}`)
    }
  }

  // Trailing CFTC refresh (reports publish Fridays for the prior Tuesday)
  try {
    const from = new Date(now - 60 * 86_400_000).toISOString().slice(0, 10)
    const closes = {
      BTC: await spotCloseHistory('BTC', from),
      ETH: await spotCloseHistory('ETH', from),
      SOL: await spotCloseHistory('SOL', from),
    }
    const cftcRows = await cftcOiHistory(from, closes)
    upsertRows('cftc_oi_weekly.json', cftcRows, (r) => `${r.date}|${r.contractName}`)
    sources.cftc = { lastSuccess: new Date().toISOString() }
  } catch (err) {
    console.error(`[cftc] ${err}`)
    sources.cftc = { lastSuccess: null }
  }

  // Venue-wide totals — every listed contract, all assets (the "everything
  // listed" scope). Offshore accumulates daily from snapshots; the onshore OI
  // side gets a year of weekly history from CFTC reports on every run.
  try {
    const totals = await allVenueTotals()
    const totalKey = (r: TotalRow) => `${r.date}|${r.venue}`
    upsertRows<TotalRow>(
      'volume_total_daily.json',
      totals
        .filter((t) => t.volumeUsd != null)
        .map((t) => ({ date, venue: t.venue, valueUsd: t.volumeUsd!, source: t.source })),
      totalKey
    )
    upsertRows<TotalRow>(
      'oi_total_daily.json',
      totals
        .filter((t) => t.oiUsd != null)
        .map((t) => ({ date, venue: t.venue, valueUsd: t.oiUsd!, source: t.source })),
      totalKey
    )

    // Weekly onshore totals: majors (already refreshed above) + XRP/BCH extras
    const from400 = new Date(now - 400 * 86_400_000).toISOString().slice(0, 10)
    const majors = readRows<CftcOiRow>('cftc_oi_weekly.json')
    const weekly = new Map<string, number>() // `${date}|${venue}` → USD
    for (const r of majors) {
      if (r.date < from400) continue
      const k = `${r.date}|${r.venue}`
      weekly.set(k, (weekly.get(k) ?? 0) + r.oiUsd)
    }
    for (const r of await cftcExtraOi(from400)) {
      const k = `${r.date}|${r.venue}`
      weekly.set(k, (weekly.get(k) ?? 0) + r.oiUsd)
    }
    upsertRows<TotalRow>(
      'oi_total_weekly_onshore.json',
      [...weekly.entries()].map(([k, valueUsd]) => {
        const [d, venue] = k.split('|')
        return { date: d, venue: venue as VenueId, valueUsd, source: 'cftc-cot' }
      }),
      totalKey
    )
    sources.totals = { lastSuccess: new Date().toISOString() }
  } catch (err) {
    console.error(`[totals] ${err}`)
    sources.totals = { lastSuccess: null }
  }

  // Listing gap: which underlyings trade offshore with no US-regulated listing
  try {
    const gap = await buildListingGap()
    writeJson('listing_gap.json', gap)
    console.log(`listing gap: ${gap.rows.length} underlyings`)
    sources.listings = { lastSuccess: new Date().toISOString() }
  } catch (err) {
    console.error(`[listings] ${err}`)
    sources.listings = { lastSuccess: null }
  }

  const key = (r: { date: string; venue: string; asset: string }) => `${r.date}|${r.venue}|${r.asset}`
  console.log(`volume rows: +${upsertRows('volume_daily.json', volumes, key)}`)
  console.log(`oi rows: +${upsertRows('oi_daily.json', ois, key)}`)
  console.log(`funding rows: +${upsertRows('funding_daily.json', fundings, key)}`)
  console.log(`depth rows: +${upsertRows('depth_daily.json', depths, key)}`)
  console.log(`basis rows: +${upsertRows('basis_daily.json', bases, key)}`)

  const meta: DatasetMeta = {
    generatedAt: new Date().toISOString(),
    lastIngestDate: date,
    sources,
  }
  writeJson('meta.json', meta)
  console.log(`ingest complete for ${date}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
