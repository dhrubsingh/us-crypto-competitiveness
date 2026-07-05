import { Asset } from '../types'
import { DailyPoint, VenueSnapshot, NormalizedBook, toDailyDate } from './common'

// Hyperliquid onchain perps, via the public info API (POST-based).
// Reachable directly from US IPs.

const INFO = 'https://api.hyperliquid.xyz/info'

async function info<T>(body: object): Promise<T> {
  const res = await fetch(INFO, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`hyperliquid HTTP ${res.status}`)
  return res.json() as Promise<T>
}

interface AssetCtx {
  dayNtlVlm: string
  openInterest: string
  funding: string
  markPx: string
}

export async function hyperliquidSnapshot(asset: Asset): Promise<VenueSnapshot> {
  const [meta, ctxs] = await info<[{ universe: { name: string }[] }, AssetCtx[]]>({
    type: 'metaAndAssetCtxs',
  })
  const idx = meta.universe.findIndex((u) => u.name === asset)
  if (idx < 0) throw new Error(`hyperliquid: ${asset} not listed`)
  const ctx = ctxs[idx]
  const mark = parseFloat(ctx.markPx)

  const l2 = await info<{ levels: [{ px: string; sz: string }[], { px: string; sz: string }[]] }>({
    type: 'l2Book',
    coin: asset,
  })
  const book: NormalizedBook = {
    bids: l2.levels[0].map((l) => [parseFloat(l.px), parseFloat(l.sz)]),
    asks: l2.levels[1].map((l) => [parseFloat(l.px), parseFloat(l.sz)]),
  }

  return {
    venue: 'hyperliquid',
    asset,
    volumeUsd24h: parseFloat(ctx.dayNtlVlm),
    oiUsd: parseFloat(ctx.openInterest) * mark,
    // funding is the hourly rate; ×8 for the 8h-equivalent
    rate8hPct: parseFloat(ctx.funding) * 8 * 100,
    markPrice: mark,
    instrument: asset,
    book,
  }
}

// --- backfill ---------------------------------------------------------------

/** Daily USD volume from daily candles (v = base volume, dollarized at close). */
export async function hyperliquidVolumeHistory(asset: Asset, fromDate: string): Promise<DailyPoint[]> {
  const startTime = new Date(`${fromDate}T00:00:00Z`).getTime()
  const candles = await info<{ t: number; c: string; v: string }[]>({
    type: 'candleSnapshot',
    req: { coin: asset, interval: '1d', startTime, endTime: Date.now() },
  })
  return candles.map((c) => ({
    date: toDailyDate(c.t),
    value: parseFloat(c.v) * parseFloat(c.c),
  }))
}

/** Daily mean funding (8h-equivalent %) from hourly funding history, paginated forward. */
export async function hyperliquidFundingHistory(asset: Asset, fromDate: string): Promise<DailyPoint[]> {
  const byDate = new Map<string, number[]>()
  let start = new Date(`${fromDate}T00:00:00Z`).getTime()
  const now = Date.now()
  for (let page = 0; page < 30 && start < now; page++) {
    const rows = await info<{ time: number; fundingRate: string }[]>({
      type: 'fundingHistory',
      coin: asset,
      startTime: start,
    })
    if (!rows.length) break
    for (const r of rows) {
      const date = toDailyDate(r.time)
      if (!byDate.has(date)) byDate.set(date, [])
      byDate.get(date)!.push(parseFloat(r.fundingRate))
    }
    const newest = Math.max(...rows.map((r) => r.time))
    if (newest <= start) break
    start = newest + 1
  }
  return [...byDate.entries()]
    .map(([date, rates]) => ({
      date,
      value: (rates.reduce((a, b) => a + b, 0) / rates.length) * 8 * 100,
    }))
    .filter((p) => p.date >= fromDate)
    .sort((a, b) => a.date.localeCompare(b.date))
}
