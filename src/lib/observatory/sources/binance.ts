import { fetchJson } from '../fetch'
import { Asset } from '../types'
import { DailyPoint, VenueSnapshot, NormalizedBook, toDailyDate } from './common'

// Binance USDT-margined perpetuals. Live endpoints geo-block US IPs and are
// reached via the fra1 relay (see ../fetch). Historical daily data comes from
// Binance's public data CDN (data.binance.vision), which is NOT geo-blocked,
// so backfill works from anywhere.

const FAPI = 'https://fapi.binance.com/fapi/v1'
const VISION = 'https://data.binance.vision/data/futures/um'

const SYMBOLS: Record<Asset, string> = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' }

interface Ticker24h { quoteVolume: string }
interface OpenInterest { openInterest: string }
interface PremiumIndex { markPrice: string; lastFundingRate: string }
interface Depth { bids: [string, string][]; asks: [string, string][] }

export async function binanceSnapshot(asset: Asset): Promise<VenueSnapshot> {
  const symbol = SYMBOLS[asset]
  const [ticker, oi, premium, depth] = await Promise.all([
    fetchJson<Ticker24h>(`${FAPI}/ticker/24hr?symbol=${symbol}`),
    fetchJson<OpenInterest>(`${FAPI}/openInterest?symbol=${symbol}`),
    fetchJson<PremiumIndex>(`${FAPI}/premiumIndex?symbol=${symbol}`),
    fetchJson<Depth>(`${FAPI}/depth?symbol=${symbol}&limit=500`),
  ])
  const mark = parseFloat(premium.markPrice)
  const book: NormalizedBook = {
    bids: depth.bids.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
    asks: depth.asks.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
  }
  return {
    venue: 'binance',
    asset,
    volumeUsd24h: parseFloat(ticker.quoteVolume),
    oiUsd: parseFloat(oi.openInterest) * mark,
    rate8hPct: parseFloat(premium.lastFundingRate) * 100,
    markPrice: mark,
    instrument: symbol,
    book,
  }
}

// --- backfill ---------------------------------------------------------------

async function fetchVisionZip(path: string): Promise<string | null> {
  const res = await fetch(`${VISION}/${path}`, { signal: AbortSignal.timeout(30_000) })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`binance vision HTTP ${res.status} for ${path}`)
  const buf = new Uint8Array(await res.arrayBuffer())
  const { unzipSync, strFromU8 } = await import('fflate')
  const files = unzipSync(buf)
  const first = Object.values(files)[0]
  return first ? strFromU8(first) : null
}

function parseKlineCsv(csv: string): { date: string; quoteVolume: number; close: number }[] {
  return csv
    .trim()
    .split('\n')
    .filter((line) => /^\d/.test(line)) // skip header row if present
    .map((line) => {
      const cols = line.split(',')
      return {
        date: toDailyDate(parseInt(cols[0], 10)),
        close: parseFloat(cols[4]),
        quoteVolume: parseFloat(cols[7]),
      }
    })
}

/** Daily quote (USD) volume from monthly kline archives, plus daily archives for the current month. */
export async function binanceVolumeHistory(asset: Asset, fromDate: string): Promise<DailyPoint[]> {
  const symbol = SYMBOLS[asset]
  const out: DailyPoint[] = []
  const start = new Date(`${fromDate}T00:00:00Z`)
  const now = new Date()

  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
  const currentMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  while (cursor.getTime() < currentMonth) {
    const ym = cursor.toISOString().slice(0, 7)
    const csv = await fetchVisionZip(`monthly/klines/${symbol}/1d/${symbol}-1d-${ym}.zip`)
    if (csv) for (const row of parseKlineCsv(csv)) out.push({ date: row.date, value: row.quoteVolume })
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  // Current month arrives as one file per day, published with ~1 day lag
  for (let d = new Date(currentMonth); d <= now; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10)
    const csv = await fetchVisionZip(`daily/klines/${symbol}/1d/${symbol}-1d-${day}.zip`)
    if (csv) for (const row of parseKlineCsv(csv)) out.push({ date: row.date, value: row.quoteVolume })
  }
  return out.filter((p) => p.date >= fromDate)
}

/** Daily close prices from the same kline archives (used to dollarize OI/contract series). */
export async function binanceCloseHistory(asset: Asset, fromDate: string): Promise<DailyPoint[]> {
  const symbol = SYMBOLS[asset]
  const out: DailyPoint[] = []
  const start = new Date(`${fromDate}T00:00:00Z`)
  const now = new Date()
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
  const currentMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  while (cursor.getTime() < currentMonth) {
    const ym = cursor.toISOString().slice(0, 7)
    const csv = await fetchVisionZip(`monthly/klines/${symbol}/1d/${symbol}-1d-${ym}.zip`)
    if (csv) for (const row of parseKlineCsv(csv)) out.push({ date: row.date, value: row.close })
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  for (let d = new Date(currentMonth); d <= now; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10)
    const csv = await fetchVisionZip(`daily/klines/${symbol}/1d/${symbol}-1d-${day}.zip`)
    if (csv) for (const row of parseKlineCsv(csv)) out.push({ date: row.date, value: row.close })
  }
  return out.filter((p) => p.date >= fromDate)
}

/** Daily mean funding (8h-equivalent %, Binance funds every 8h) from monthly archives. */
export async function binanceFundingHistory(asset: Asset, fromDate: string): Promise<DailyPoint[]> {
  const symbol = SYMBOLS[asset]
  const byDate = new Map<string, number[]>()
  const start = new Date(`${fromDate}T00:00:00Z`)
  const now = new Date()
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
  while (cursor <= now) {
    const ym = cursor.toISOString().slice(0, 7)
    const csv = await fetchVisionZip(`monthly/fundingRate/${symbol}/${symbol}-fundingRate-${ym}.zip`)
    if (csv) {
      for (const line of csv.trim().split('\n')) {
        if (!/^\d/.test(line)) continue
        const cols = line.split(',')
        const date = toDailyDate(parseInt(cols[0], 10))
        const rate = parseFloat(cols[2])
        if (!Number.isFinite(rate)) continue
        if (!byDate.has(date)) byDate.set(date, [])
        byDate.get(date)!.push(rate)
      }
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return [...byDate.entries()]
    .map(([date, rates]) => ({ date, value: (rates.reduce((a, b) => a + b, 0) / rates.length) * 100 }))
    .filter((p) => p.date >= fromDate)
    .sort((a, b) => a.date.localeCompare(b.date))
}

/** OI history via fapi (via relay). Binance only retains ~30 days at daily resolution. */
export async function binanceOiHistory(asset: Asset): Promise<DailyPoint[]> {
  const symbol = SYMBOLS[asset]
  const rows = await fetchJson<{ timestamp: number; sumOpenInterestValue: string }[]>(
    `https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=1d&limit=500`
  )
  return rows.map((r) => ({ date: toDailyDate(r.timestamp), value: parseFloat(r.sumOpenInterestValue) }))
}
