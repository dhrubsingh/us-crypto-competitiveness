import { fetchJson } from '../fetch'
import { Asset } from '../types'
import { DailyPoint, VenueSnapshot, NormalizedBook, toDailyDate } from './common'

// Deribit. Reachable directly from US IPs. BTC/ETH futures are inverse
// (contracts denominated in USD); SOL trades as a linear USDC perp.
// Venue totals sum every live futures instrument (perp + dated) per asset;
// history is perp-only since dated contracts roll.

const API = 'https://www.deribit.com/api/v2/public'

const PERP: Record<Asset, string> = {
  BTC: 'BTC-PERPETUAL',
  ETH: 'ETH-PERPETUAL',
  SOL: 'SOL_USDC-PERPETUAL',
}

interface DeribitResult<T> {
  result: T
}

async function deribit<T>(path: string): Promise<T> {
  const res = await fetchJson<DeribitResult<T>>(`${API}${path}`)
  return res.result
}

interface BookSummary {
  instrument_name: string
  volume_usd: number
  open_interest: number
  mark_price: number
  funding_8h?: number
}

async function assetSummaries(asset: Asset): Promise<BookSummary[]> {
  if (asset === 'SOL') {
    // SOL lives under the USDC linear complex; filter to SOL_USDC instruments
    const all = await deribit<BookSummary[]>('/get_book_summary_by_currency?currency=USDC&kind=future')
    return all.filter((s) => s.instrument_name.startsWith('SOL_USDC'))
  }
  return deribit<BookSummary[]>(`/get_book_summary_by_currency?currency=${asset}&kind=future`)
}

export async function deribitSnapshot(asset: Asset): Promise<VenueSnapshot> {
  const perpName = PERP[asset]
  const [summaries, orderBook] = await Promise.all([
    assetSummaries(asset),
    deribit<{ bids: [number, number][]; asks: [number, number][]; mark_price: number }>(
      `/get_order_book?instrument_name=${perpName}&depth=1000`
    ),
  ])

  const perp = summaries.find((s) => s.instrument_name === perpName)
  const mark = perp?.mark_price ?? orderBook.mark_price

  const volumeUsd = summaries.reduce((sum, s) => sum + (s.volume_usd ?? 0), 0)
  // Inverse contracts (BTC/ETH) report open_interest in USD already; the
  // linear SOL_USDC perp reports it in SOL and needs dollarizing.
  const oiUsd = summaries.reduce((sum, s) => {
    const raw = s.open_interest ?? 0
    return sum + (asset === 'SOL' ? raw * (s.mark_price ?? mark) : raw)
  }, 0)

  // Order book amounts follow the same convention: USD for inverse, base for linear
  const toBase = (price: number, amount: number) => (asset === 'SOL' ? amount : amount / price)
  const book: NormalizedBook = {
    bids: orderBook.bids.map(([p, a]) => [p, toBase(p, a)]),
    asks: orderBook.asks.map(([p, a]) => [p, toBase(p, a)]),
  }

  return {
    venue: 'deribit',
    asset,
    volumeUsd24h: volumeUsd,
    oiUsd,
    rate8hPct: perp?.funding_8h != null ? perp.funding_8h * 100 : null,
    markPrice: mark,
    instrument: perpName,
    book,
  }
}

// --- backfill ---------------------------------------------------------------

/** Daily USD volume for the perp from TradingView chart data (`cost` = USD notional). */
export async function deribitVolumeHistory(asset: Asset, fromDate: string): Promise<DailyPoint[]> {
  const start = new Date(`${fromDate}T00:00:00Z`).getTime()
  const end = Date.now()
  const res = await deribit<{ ticks: number[]; cost: number[]; status: string }>(
    `/get_tradingview_chart_data?instrument_name=${PERP[asset]}&resolution=1D&start_timestamp=${start}&end_timestamp=${end}`
  )
  if (res.status !== 'ok') return []
  return res.ticks.map((t, i) => ({ date: toDailyDate(t), value: res.cost[i] }))
}

/** Daily mean funding (8h-equivalent %) from hourly funding history, paginated. */
export async function deribitFundingHistory(asset: Asset, fromDate: string): Promise<DailyPoint[]> {
  const byDate = new Map<string, number[]>()
  const startTs = new Date(`${fromDate}T00:00:00Z`).getTime()
  let end = Date.now()
  // Each call returns up to ~744 hourly points (a month's worth)
  for (let page = 0; page < 14 && end > startTs; page++) {
    const rows = await deribit<{ timestamp: number; interest_8h: number }[]>(
      `/get_funding_rate_history?instrument_name=${PERP[asset]}&start_timestamp=${Math.max(startTs, end - 31 * 86_400_000)}&end_timestamp=${end}`
    )
    if (!rows.length) break
    for (const r of rows) {
      const date = toDailyDate(r.timestamp)
      if (!byDate.has(date)) byDate.set(date, [])
      byDate.get(date)!.push(r.interest_8h)
    }
    end = Math.min(...rows.map((r) => r.timestamp)) - 1
  }
  return [...byDate.entries()]
    .map(([date, rates]) => ({ date, value: (rates.reduce((a, b) => a + b, 0) / rates.length) * 100 }))
    .filter((p) => p.date >= fromDate)
    .sort((a, b) => a.date.localeCompare(b.date))
}
