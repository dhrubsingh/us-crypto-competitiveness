import { fetchJson } from '../fetch'
import { Asset } from '../types'
import { DailyPoint, VenueSnapshot, NormalizedBook, toDailyDate } from './common'

// Bybit linear (USDT) perpetuals. All endpoints geo-block US IPs and are
// reached via the fra1 relay. History comes from the same v5 REST API.

const V5 = 'https://api.bybit.com/v5/market'

const SYMBOLS: Record<Asset, string> = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' }

interface BybitResponse<T> {
  retCode: number
  retMsg: string
  result: T
}

async function bybit<T>(path: string): Promise<T> {
  const res = await fetchJson<BybitResponse<T>>(`${V5}${path}`)
  if (res.retCode !== 0) throw new Error(`bybit ${path}: ${res.retMsg}`)
  return res.result
}

export async function bybitSnapshot(asset: Asset): Promise<VenueSnapshot> {
  const symbol = SYMBOLS[asset]
  const [tickers, orderbook] = await Promise.all([
    bybit<{ list: { turnover24h: string; openInterestValue: string; fundingRate: string; markPrice: string }[] }>(
      `/tickers?category=linear&symbol=${symbol}`
    ),
    bybit<{ b: [string, string][]; a: [string, string][] }>(
      `/orderbook?category=linear&symbol=${symbol}&limit=500`
    ),
  ])
  const t = tickers.list[0]
  const book: NormalizedBook = {
    bids: orderbook.b.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
    asks: orderbook.a.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
  }
  return {
    venue: 'bybit',
    asset,
    volumeUsd24h: parseFloat(t.turnover24h),
    oiUsd: parseFloat(t.openInterestValue),
    rate8hPct: parseFloat(t.fundingRate) * 100,
    markPrice: parseFloat(t.markPrice),
    instrument: symbol,
    book,
  }
}

// --- backfill ---------------------------------------------------------------

/** Daily USD turnover from v5 klines (list is reverse-chronological, 200 rows/page). */
export async function bybitVolumeHistory(asset: Asset, fromDate: string): Promise<DailyPoint[]> {
  const symbol = SYMBOLS[asset]
  const out: DailyPoint[] = []
  let end = Date.now()
  const fromTs = new Date(`${fromDate}T00:00:00Z`).getTime()
  while (end > fromTs) {
    const res = await bybit<{ list: string[][] }>(
      `/kline?category=linear&symbol=${symbol}&interval=D&limit=200&end=${end}`
    )
    if (!res.list.length) break
    for (const row of res.list) {
      out.push({ date: toDailyDate(parseInt(row[0], 10)), value: parseFloat(row[6]) })
    }
    const oldest = parseInt(res.list[res.list.length - 1][0], 10)
    if (oldest >= end) break
    end = oldest - 1
  }
  return out.filter((p) => p.date >= fromDate).sort((a, b) => a.date.localeCompare(b.date))
}

/** Daily close, for dollarizing OI. */
export async function bybitCloseHistory(asset: Asset, fromDate: string): Promise<Map<string, number>> {
  const symbol = SYMBOLS[asset]
  const closes = new Map<string, number>()
  let end = Date.now()
  const fromTs = new Date(`${fromDate}T00:00:00Z`).getTime()
  while (end > fromTs) {
    const res = await bybit<{ list: string[][] }>(
      `/kline?category=linear&symbol=${symbol}&interval=D&limit=200&end=${end}`
    )
    if (!res.list.length) break
    for (const row of res.list) closes.set(toDailyDate(parseInt(row[0], 10)), parseFloat(row[4]))
    const oldest = parseInt(res.list[res.list.length - 1][0], 10)
    if (oldest >= end) break
    end = oldest - 1
  }
  return closes
}

/** Daily OI in USD (Bybit reports OI in base units; dollarized with same-day close). */
export async function bybitOiHistory(asset: Asset, fromDate: string): Promise<DailyPoint[]> {
  const symbol = SYMBOLS[asset]
  const closes = await bybitCloseHistory(asset, fromDate)
  const out: DailyPoint[] = []
  let cursor: string | undefined
  const fromTs = new Date(`${fromDate}T00:00:00Z`).getTime()
  for (let page = 0; page < 10; page++) {
    const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
    const res = await bybit<{ list: { openInterest: string; timestamp: string }[]; nextPageCursor?: string }>(
      `/open-interest?category=linear&symbol=${symbol}&intervalTime=1d&limit=200${cursorParam}`
    )
    for (const row of res.list) {
      const ts = parseInt(row.timestamp, 10)
      const date = toDailyDate(ts)
      const close = closes.get(date)
      if (close) out.push({ date, value: parseFloat(row.openInterest) * close })
    }
    if (!res.nextPageCursor || !res.list.length) break
    const oldest = parseInt(res.list[res.list.length - 1].timestamp, 10)
    if (oldest < fromTs) break
    cursor = res.nextPageCursor
  }
  return out.filter((p) => p.date >= fromDate).sort((a, b) => a.date.localeCompare(b.date))
}

/** Daily mean funding (8h-equivalent %; Bybit funds every 8h). */
export async function bybitFundingHistory(asset: Asset, fromDate: string): Promise<DailyPoint[]> {
  const symbol = SYMBOLS[asset]
  const byDate = new Map<string, number[]>()
  let end = Date.now()
  const fromTs = new Date(`${fromDate}T00:00:00Z`).getTime()
  for (let page = 0; page < 12 && end > fromTs; page++) {
    const res = await bybit<{ list: { fundingRate: string; fundingRateTimestamp: string }[] }>(
      `/funding/history?category=linear&symbol=${symbol}&limit=200&endTime=${end}`
    )
    if (!res.list.length) break
    for (const row of res.list) {
      const ts = parseInt(row.fundingRateTimestamp, 10)
      const date = toDailyDate(ts)
      if (!byDate.has(date)) byDate.set(date, [])
      byDate.get(date)!.push(parseFloat(row.fundingRate))
    }
    const oldest = parseInt(res.list[res.list.length - 1].fundingRateTimestamp, 10)
    if (oldest >= end) break
    end = oldest - 1
  }
  return [...byDate.entries()]
    .map(([date, rates]) => ({ date, value: (rates.reduce((a, b) => a + b, 0) / rates.length) * 100 }))
    .filter((p) => p.date >= fromDate)
    .sort((a, b) => a.date.localeCompare(b.date))
}
