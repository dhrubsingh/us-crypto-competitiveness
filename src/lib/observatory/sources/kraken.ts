import { fetchJson } from '../fetch'
import { Asset } from '../types'
import { DailyPoint, VenueSnapshot, NormalizedBook, toDailyDate } from './common'

// Kraken Futures (Crypto Facilities). Public market data is reachable from US
// IPs — no relay needed. Venue totals sum every listed contract per asset:
// linear multi-collateral (PF_/FF_, sized in coin) and legacy inverse
// (PI_/FI_, $1 contracts, sized in USD). The dominant PF_ perp carries the
// funding/book/history representation.

const API = 'https://futures.kraken.com'

const PAIR: Record<Asset, string> = { BTC: 'XBT', ETH: 'ETH', SOL: 'SOL' }
const PERP: Record<Asset, string> = { BTC: 'PF_XBTUSD', ETH: 'PF_ETHUSD', SOL: 'PF_SOLUSD' }

interface KrakenTicker {
  symbol: string
  volumeQuote?: number
  openInterest?: number
  markPrice?: number
}

function matchesAsset(symbol: string, asset: Asset): boolean {
  // e.g. PF_XBTUSD, PI_XBTUSD, FF_XBTUSD_260925 — the pair root follows the underscore
  return symbol.toUpperCase().startsWith(`P`) || symbol.toUpperCase().startsWith(`F`)
    ? symbol.toUpperCase().includes(`_${PAIR[asset]}USD`)
    : false
}

const isInverse = (symbol: string) => /^(PI|FI)_/i.test(symbol)

export async function krakenSnapshot(asset: Asset): Promise<VenueSnapshot> {
  const { tickers } = await fetchJson<{ tickers: KrakenTicker[] }>(`${API}/derivatives/api/v3/tickers`)
  const matched = tickers.filter((t) => matchesAsset(t.symbol, asset))
  if (!matched.length) throw new Error(`kraken: no ${asset} contracts`)

  const perp = matched.find((t) => t.symbol === PERP[asset])
  const mark = perp?.markPrice ?? null

  let volumeUsd = 0
  let oiUsd = 0
  for (const t of matched) {
    volumeUsd += t.volumeQuote ?? 0
    const oi = t.openInterest ?? 0
    oiUsd += isInverse(t.symbol) ? oi : oi * (t.markPrice ?? mark ?? 0)
  }

  // Ticker fundingRate is an absolute dollar figure; the comparable relative
  // hourly rate comes from the funding-history endpoint's latest entry.
  let rate8hPct: number | null = null
  try {
    const { rates } = await fetchJson<{ rates: { relativeFundingRate: number }[] }>(
      `${API}/derivatives/api/v4/historicalfundingrates?symbol=${PERP[asset]}`
    )
    const latest = rates[rates.length - 1]
    if (latest) rate8hPct = latest.relativeFundingRate * 8 * 100
  } catch {
    // funding optional
  }

  let book: NormalizedBook | null = null
  try {
    const { orderBook } = await fetchJson<{ orderBook: { bids: [number, number][]; asks: [number, number][] } }>(
      `${API}/derivatives/api/v3/orderbook?symbol=${PERP[asset]}`
    )
    if (orderBook.bids.length && orderBook.asks.length) {
      // PF_ books are [price, size in coin]; Kraken returns bids ascending
      // (worst first), so both sides are sorted best-first defensively
      book = {
        bids: [...orderBook.bids].sort((a, b) => b[0] - a[0]),
        asks: [...orderBook.asks].sort((a, b) => a[0] - b[0]),
      }
    }
  } catch {
    // book optional
  }

  return {
    venue: 'kraken',
    asset,
    volumeUsd24h: volumeUsd || null,
    oiUsd: oiUsd || null,
    rate8hPct,
    markPrice: mark,
    instrument: PERP[asset],
    book,
  }
}

// --- backfill ---------------------------------------------------------------

/** Daily USD volume for the PF_ perp from the charts API (volume in coin × close). */
export async function krakenVolumeHistory(asset: Asset, fromDate: string): Promise<DailyPoint[]> {
  const from = Math.floor(new Date(`${fromDate}T00:00:00Z`).getTime() / 1000)
  const to = Math.floor(Date.now() / 1000)
  const { candles } = await fetchJson<{
    candles: { time: number; close: string; volume: string }[]
  }>(`${API}/api/charts/v1/trade/${PERP[asset]}/1d?from=${from}&to=${to}`)
  return candles
    .map((c) => ({ date: toDailyDate(c.time), value: parseFloat(c.volume) * parseFloat(c.close) }))
    .filter((p) => p.date >= fromDate && Number.isFinite(p.value))
}

/** Daily mean funding (8h-equivalent %) from hourly relative rates. */
export async function krakenFundingHistory(asset: Asset, fromDate: string): Promise<DailyPoint[]> {
  const { rates } = await fetchJson<{
    rates: { timestamp: string; relativeFundingRate: number }[]
  }>(`${API}/derivatives/api/v4/historicalfundingrates?symbol=${PERP[asset]}`)
  const byDate = new Map<string, number[]>()
  for (const r of rates) {
    const date = r.timestamp.slice(0, 10)
    if (date < fromDate) continue
    if (!byDate.has(date)) byDate.set(date, [])
    byDate.get(date)!.push(r.relativeFundingRate)
  }
  return [...byDate.entries()]
    .map(([date, xs]) => ({ date, value: (xs.reduce((a, b) => a + b, 0) / xs.length) * 8 * 100 }))
    .sort((a, b) => a.date.localeCompare(b.date))
}
