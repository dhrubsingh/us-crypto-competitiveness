import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ListingGap } from './sources/listings'
import {
  Asset,
  ASSETS,
  VenueId,
  VENUES,
  VolumeRow,
  OiRow,
  FundingRow,
  DepthRow,
  BasisRow,
  CftcOiRow,
  RegulatoryEvent,
  DatasetMeta,
  TotalRow,
} from './types'

// Server-side metrics layer: reads the flat-file datasets under public/data
// and shapes them into chart-ready series. All aggregation choices that
// affect interpretation are documented on the methodology page.

const DATA_DIR = join(process.cwd(), 'public', 'data')

function read<T>(file: string): T[] {
  const path = join(DATA_DIR, file)
  if (!existsSync(path)) return []
  return JSON.parse(readFileSync(path, 'utf8')) as T[]
}

export interface Observatory {
  volume: VolumeRow[]
  oi: OiRow[]
  funding: FundingRow[]
  depth: DepthRow[]
  basis: BasisRow[]
  cftc: CftcOiRow[]
  volumeTotal: TotalRow[]
  oiTotal: TotalRow[]
  oiTotalWeeklyOnshore: TotalRow[]
  listingGap: ListingGap | null
  events: RegulatoryEvent[]
  meta: DatasetMeta | null
}

let cache: Observatory | null = null

export function loadObservatory(): Observatory {
  if (cache && process.env.NODE_ENV === 'production') return cache
  const metaPath = join(DATA_DIR, 'meta.json')
  cache = {
    volume: read<VolumeRow>('volume_daily.json'),
    oi: read<OiRow>('oi_daily.json'),
    funding: read<FundingRow>('funding_daily.json'),
    depth: read<DepthRow>('depth_daily.json'),
    basis: read<BasisRow>('basis_daily.json'),
    cftc: read<CftcOiRow>('cftc_oi_weekly.json'),
    volumeTotal: read<TotalRow>('volume_total_daily.json'),
    oiTotal: read<TotalRow>('oi_total_daily.json'),
    oiTotalWeeklyOnshore: read<TotalRow>('oi_total_weekly_onshore.json'),
    listingGap: existsSync(join(DATA_DIR, 'listing_gap.json'))
      ? (JSON.parse(readFileSync(join(DATA_DIR, 'listing_gap.json'), 'utf8')) as ListingGap)
      : null,
    events: read<RegulatoryEvent>('events.json'),
    meta: existsSync(metaPath) ? (JSON.parse(readFileSync(metaPath, 'utf8')) as DatasetMeta) : null,
  }
  return cache
}

export type AssetFilter = Asset | 'ALL'

const matchesAsset = (rowAsset: Asset, filter: AssetFilter) => filter === 'ALL' || rowAsset === filter

// ---------------------------------------------------------------------------
// Module 1 — market share
// ---------------------------------------------------------------------------

export interface SharePoint {
  date: string
  onshoreUsd: number
  offshoreUsd: number
  sharePct: number
}

/** Daily onshore share of traded volume. */
export function volumeShareSeries(data: Observatory, asset: AssetFilter): SharePoint[] {
  const byDate = new Map<string, { on: number; off: number }>()
  for (const r of data.volume) {
    if (!matchesAsset(r.asset, asset)) continue
    const bucket = byDate.get(r.date) ?? { on: 0, off: 0 }
    if (VENUES[r.venue].region === 'onshore') bucket.on += r.volumeUsd
    else bucket.off += r.volumeUsd
    byDate.set(r.date, bucket)
  }
  return [...byDate.entries()]
    .filter(([, b]) => b.on + b.off > 0)
    .map(([date, b]) => ({
      date,
      onshoreUsd: b.on,
      offshoreUsd: b.off,
      sharePct: (b.on / (b.on + b.off)) * 100,
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

/** Trailing mean over `days`; leading points with incomplete windows are dropped. */
export function smooth(series: SharePoint[], days: number): SharePoint[] {
  return series
    .map((p, i) => {
      const window = series.slice(Math.max(0, i - days + 1), i + 1)
      const on = window.reduce((s, w) => s + w.onshoreUsd, 0)
      const off = window.reduce((s, w) => s + w.offshoreUsd, 0)
      return { ...p, onshoreUsd: on / window.length, offshoreUsd: off / window.length, sharePct: (on / (on + off)) * 100 }
    })
    .slice(Math.min(days - 1, Math.max(series.length - 1, 0)))
}

export interface VenueSeriesPoint {
  date: string
  values: Partial<Record<VenueId, number>>
}

/** Daily volume per onshore venue (stacked-chart shape). */
export function onshoreVolumeByVenue(data: Observatory, asset: AssetFilter): VenueSeriesPoint[] {
  const byDate = new Map<string, Partial<Record<VenueId, number>>>()
  for (const r of data.volume) {
    if (!matchesAsset(r.asset, asset) || VENUES[r.venue].region !== 'onshore') continue
    const bucket = byDate.get(r.date) ?? {}
    bucket[r.venue] = (bucket[r.venue] ?? 0) + r.volumeUsd
    byDate.set(r.date, bucket)
  }
  return [...byDate.entries()]
    .map(([date, values]) => ({ date, values }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

export interface CftcWeekPoint {
  date: string
  cmeUsd: number
  cdeUsd: number
}

/** Weekly onshore OI from CFTC COT, split CME vs Coinbase Derivatives. */
export function cftcWeeklySeries(data: Observatory, asset: AssetFilter): CftcWeekPoint[] {
  const byDate = new Map<string, { cme: number; cde: number }>()
  for (const r of data.cftc) {
    if (!matchesAsset(r.asset, asset)) continue
    const bucket = byDate.get(r.date) ?? { cme: 0, cde: 0 }
    bucket[r.venue] += r.oiUsd
    byDate.set(r.date, bucket)
  }
  return [...byDate.entries()]
    .map(([date, b]) => ({ date, cmeUsd: b.cme, cdeUsd: b.cde }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Daily onshore share of open interest. The offshore denominator is held to a
 * fixed venue set — Binance, Bybit, OKX, the three largest — because Deribit
 * and Hyperliquid publish no OI history: letting venues drift in and out of
 * the denominator would fabricate share moves. Onshore side = CFTC weekly
 * forward-filled + Kalshi daily.
 */
export function oiShareSeries(data: Observatory, asset: AssetFilter): SharePoint[] {
  const REQUIRED: VenueId[] = ['binance', 'bybit', 'okx']
  const offByDate = new Map<string, Map<VenueId, number>>()
  for (const r of data.oi) {
    if (!matchesAsset(r.asset, asset) || !REQUIRED.includes(r.venue)) continue
    if (!offByDate.has(r.date)) offByDate.set(r.date, new Map())
    const m = offByDate.get(r.date)!
    m.set(r.venue, (m.get(r.venue) ?? 0) + r.oiUsd)
  }

  // Daily-reported onshore OI (Kalshi, Kraken US) supplements the weekly CFTC series
  const onshoreDailyByDate = new Map<string, number>()
  for (const r of data.oi) {
    if ((r.venue === 'kalshi' || r.venue === 'kraken_us') && matchesAsset(r.asset, asset)) {
      onshoreDailyByDate.set(r.date, (onshoreDailyByDate.get(r.date) ?? 0) + r.oiUsd)
    }
  }

  const cftcWeekly = cftcWeeklySeries(data, asset)

  const out: SharePoint[] = []
  for (const [date, venues] of [...offByDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!REQUIRED.every((v) => venues.has(v))) continue
    const off = [...venues.values()].reduce((a, b) => a + b, 0)
    // forward-fill the latest CFTC report at or before this date
    const cftcAt = [...cftcWeekly].reverse().find((w) => w.date <= date)
    if (!cftcAt) continue
    const on = cftcAt.cmeUsd + cftcAt.cdeUsd + (onshoreDailyByDate.get(date) ?? 0)
    out.push({ date, onshoreUsd: on, offshoreUsd: off, sharePct: (on / (on + off)) * 100 })
  }
  return out
}

// ---------------------------------------------------------------------------
// "Everything listed" — venue-wide totals across every contract
// ---------------------------------------------------------------------------

/** Daily onshore share of venue-wide traded volume (all listed contracts). */
export function totalVolumeShareSeries(data: Observatory): SharePoint[] {
  const byDate = new Map<string, { on: number; off: number }>()
  for (const r of data.volumeTotal) {
    const bucket = byDate.get(r.date) ?? { on: 0, off: 0 }
    if (VENUES[r.venue].region === 'onshore') bucket.on += r.valueUsd
    else bucket.off += r.valueUsd
    byDate.set(r.date, bucket)
  }
  return [...byDate.entries()]
    .filter(([, b]) => b.on + b.off > 0)
    .map(([date, b]) => ({
      date,
      onshoreUsd: b.on,
      offshoreUsd: b.off,
      sharePct: (b.on / (b.on + b.off)) * 100,
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Daily onshore share of venue-wide open interest. Offshore side requires
 * Binance, Bybit and OKX (the largest) to be present; onshore = weekly CFTC
 * totals forward-filled + daily venue-reported (Kalshi, Kraken US).
 */
export function totalOiShareSeries(data: Observatory): SharePoint[] {
  const REQUIRED: VenueId[] = ['binance', 'bybit', 'okx']
  const offByDate = new Map<string, Map<VenueId, number>>()
  const onDailyByDate = new Map<string, number>()
  for (const r of data.oiTotal) {
    if (VENUES[r.venue].region === 'offshore') {
      if (!offByDate.has(r.date)) offByDate.set(r.date, new Map())
      offByDate.get(r.date)!.set(r.venue, r.valueUsd)
    } else {
      onDailyByDate.set(r.date, (onDailyByDate.get(r.date) ?? 0) + r.valueUsd)
    }
  }
  const weekly = new Map<string, number>()
  for (const r of data.oiTotalWeeklyOnshore) {
    weekly.set(r.date, (weekly.get(r.date) ?? 0) + r.valueUsd)
  }
  const weeklyDates = [...weekly.keys()].sort()

  const out: SharePoint[] = []
  for (const [date, venues] of [...offByDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!REQUIRED.every((v) => venues.has(v))) continue
    const off = [...venues.values()].reduce((a, b) => a + b, 0)
    const weeklyAt = [...weeklyDates].reverse().find((d) => d <= date)
    if (!weeklyAt) continue
    const on = weekly.get(weeklyAt)! + (onDailyByDate.get(date) ?? 0)
    out.push({ date, onshoreUsd: on, offshoreUsd: off, sharePct: (on / (on + off)) * 100 })
  }
  return out
}

// ---------------------------------------------------------------------------
// Module 2 — the onshore premium
// ---------------------------------------------------------------------------

export const annualize8h = (rate8hPct: number) => rate8hPct * 3 * 365

export interface FundingPoint {
  date: string
  /** Equal-weight mean of available offshore perp funding, annualized %. */
  offshorePct: number | null
  /** Equal-weight mean of available onshore perp funding (CDE, Kalshi, Kraken US), annualized %. */
  onshorePct: number | null
  /** Per-venue onshore detail, kept for the CSV export. */
  cdePct: number | null
  kalshiPct: number | null
  krakenUsPct: number | null
}

export function fundingSeries(data: Observatory, asset: AssetFilter): FundingPoint[] {
  const byDate = new Map<string, { off: number[]; byVenue: Map<VenueId, number[]> }>()
  for (const r of data.funding) {
    if (!matchesAsset(r.asset, asset)) continue
    const bucket = byDate.get(r.date) ?? { off: [], byVenue: new Map<VenueId, number[]>() }
    if (VENUES[r.venue].region === 'offshore') {
      bucket.off.push(r.rate8hPct)
    } else if (r.venue !== 'cme') {
      if (!bucket.byVenue.has(r.venue)) bucket.byVenue.set(r.venue, [])
      bucket.byVenue.get(r.venue)!.push(r.rate8hPct)
    }
    byDate.set(r.date, bucket)
  }
  const mean = (xs: number[] | undefined) => (xs?.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
  const ann = (x: number | null) => (x == null ? null : annualize8h(x))
  return [...byDate.entries()]
    .map(([date, b]) => {
      const cde = mean(b.byVenue.get('cde'))
      const kalshi = mean(b.byVenue.get('kalshi'))
      const krakenUs = mean(b.byVenue.get('kraken_us'))
      const onshoreRates = [cde, kalshi, krakenUs].filter((x): x is number => x != null)
      return {
        date,
        offshorePct: ann(mean(b.off)),
        onshorePct: onshoreRates.length ? annualize8h(onshoreRates.reduce((a, c) => a + c, 0) / onshoreRates.length) : null,
        cdePct: ann(cde),
        kalshiPct: ann(kalshi),
        krakenUsPct: ann(krakenUs),
      }
    })
    .sort((a, b) => a.date.localeCompare(b.date))
}

export interface BasisPoint {
  date: string
  cmeBasisPct: number | null
}

/** CME annualized front-month basis. */
export function cmeBasisSeries(data: Observatory, asset: AssetFilter): BasisPoint[] {
  const byDate = new Map<string, number[]>()
  for (const r of data.basis) {
    if (r.venue !== 'cme' || r.kind !== 'future' || !matchesAsset(r.asset, asset)) continue
    if (!byDate.has(r.date)) byDate.set(r.date, [])
    byDate.get(r.date)!.push(r.basisAnnualizedPct)
  }
  return [...byDate.entries()]
    .map(([date, xs]) => ({ date, cmeBasisPct: xs.reduce((a, b) => a + b, 0) / xs.length }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

/** Latest depth/spread comparison rows, grouped per asset. */
export function latestDepth(data: Observatory): Record<Asset, DepthRow[]> {
  const latestDate = data.depth.reduce((max, r) => (r.date > max ? r.date : max), '')
  const out = { BTC: [], ETH: [], SOL: [] } as Record<Asset, DepthRow[]>
  for (const r of data.depth) {
    if (r.date === latestDate) out[r.asset].push(r)
  }
  for (const asset of ASSETS) out[asset].sort((a, b) => a.venue.localeCompare(b.venue))
  return out
}

// ---------------------------------------------------------------------------
// Headline stats
// ---------------------------------------------------------------------------

export interface Headline {
  asOf: string
  volumeShare7dPct: number | null
  volumeShareDelta30dPct: number | null
  oiSharePct: number | null
  onshoreOiUsd: number | null
  /** Offshore composite minus onshore composite funding, annualized percentage points. */
  fundingDivergencePct: number | null
  /** Cheapest onshore $1M fill cost minus cheapest offshore, bps. */
  executionGapBps: number | null
}

export function headline(data: Observatory): Headline {
  const share = smooth(volumeShareSeries(data, 'ALL'), 7)
  const latest = share[share.length - 1] ?? null
  const prior30 = share[share.length - 31] ?? null

  const oiShare = oiShareSeries(data, 'ALL')
  const latestOi = oiShare[oiShare.length - 1] ?? null

  // Divergence from 7-day means of each composite (matching the chart's
  // treatment — a single 8h funding print shouldn't set the headline)
  const funding = fundingSeries(data, 'ALL')
  const trailing7 = (pick: (f: FundingPoint) => number | null): number | null => {
    const vals = funding.slice(-7).map(pick).filter((v): v is number => v != null)
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
  }
  const off7 = trailing7((f) => f.offshorePct)
  const on7 = trailing7((f) => f.onshorePct)
  const divergence = off7 != null && on7 != null ? off7 - on7 : null

  const depth = latestDepth(data)
  let executionGapBps: number | null = null
  const btcDepth = depth.BTC
  const on = btcDepth.filter((d) => VENUES[d.venue].region === 'onshore' && d.fillCost1mBps != null)
  const off = btcDepth.filter((d) => VENUES[d.venue].region === 'offshore' && d.fillCost1mBps != null)
  if (on.length && off.length) {
    executionGapBps =
      Math.min(...on.map((d) => d.fillCost1mBps!)) - Math.min(...off.map((d) => d.fillCost1mBps!))
  }

  return {
    asOf: data.meta?.lastIngestDate ?? latest?.date ?? '',
    volumeShare7dPct: latest?.sharePct ?? null,
    volumeShareDelta30dPct: latest && prior30 ? latest.sharePct - prior30.sharePct : null,
    oiSharePct: latestOi?.sharePct ?? null,
    onshoreOiUsd: latestOi?.onshoreUsd ?? null,
    fundingDivergencePct: divergence,
    executionGapBps,
  }
}
