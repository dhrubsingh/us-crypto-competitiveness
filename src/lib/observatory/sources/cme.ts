import { fetchJson } from '../fetch'
import { Asset } from '../types'
import { DailyPoint, VenueSnapshot } from './common'

// CME crypto futures. CME has no free market data API and blocks scrapers, so
// daily volume comes from Yahoo Finance's delayed feed for the front-month
// standard + micro contracts (contracts × contract size × settle). This
// undercounts total CME volume slightly (back-month expiries excluded) —
// documented on the methodology page. Open interest comes from the CFTC's
// weekly Commitments of Traders reports (see cftc.ts), which cover all
// expiries and are the authoritative public source.

const CHART = 'https://query1.finance.yahoo.com/v8/finance/chart'

interface CmeContract {
  symbol: string
  size: number // asset units per contract
}

const CONTRACTS: Record<Asset, CmeContract[]> = {
  BTC: [
    { symbol: 'BTC=F', size: 5 },
    { symbol: 'MBT=F', size: 0.1 },
  ],
  ETH: [
    { symbol: 'ETH=F', size: 50 },
    { symbol: 'MET=F', size: 0.1 },
  ],
  SOL: [
    { symbol: 'SOL=F', size: 500 },
    { symbol: 'MSL=F', size: 25 },
  ],
}

interface YahooChart {
  chart: {
    result: {
      meta: { regularMarketPrice: number }
      timestamp: number[]
      indicators: { quote: { volume: (number | null)[]; close: (number | null)[] }[] }
    }[]
  }
}

async function yahooDaily(symbol: string, range: string): Promise<{ date: string; volume: number; close: number }[]> {
  const data = await fetchJson<YahooChart>(`${CHART}/${encodeURIComponent(symbol)}?interval=1d&range=${range}`)
  const result = data.chart.result?.[0]
  if (!result?.timestamp) return []
  const { volume, close } = result.indicators.quote[0]
  const out: { date: string; volume: number; close: number }[] = []
  for (let i = 0; i < result.timestamp.length; i++) {
    const v = volume[i]
    const c = close[i]
    if (v == null || c == null) continue
    out.push({ date: new Date(result.timestamp[i] * 1000).toISOString().slice(0, 10), volume: v, close: c })
  }
  return out
}

/** Snapshot: the last *completed* session's USD volume across front-month standard + micro (the in-progress session would badly understate the day). */
export async function cmeSnapshot(asset: Asset): Promise<VenueSnapshot> {
  const today = new Date().toISOString().slice(0, 10)
  let volumeUsd = 0
  let mark: number | null = null
  for (const { symbol, size } of CONTRACTS[asset]) {
    const days = await yahooDaily(symbol, '5d')
    const completed = days.filter((d) => d.date < today)
    const latest = completed[completed.length - 1] ?? days[days.length - 1]
    if (!latest) continue
    volumeUsd += latest.volume * size * latest.close
    if (symbol === CONTRACTS[asset][0].symbol) mark = latest.close
  }
  return {
    venue: 'cme',
    asset,
    volumeUsd24h: volumeUsd || null,
    oiUsd: null, // weekly, from CFTC COT
    rate8hPct: null, // dated futures have basis, not funding
    markPrice: mark,
    instrument: CONTRACTS[asset][0].symbol,
    book: null, // depth requires a paid vendor
  }
}

/** Daily USD volume history (front-month standard + micro summed). */
export async function cmeVolumeHistory(asset: Asset, fromDate: string): Promise<DailyPoint[]> {
  const byDate = new Map<string, number>()
  for (const { symbol, size } of CONTRACTS[asset]) {
    for (const d of await yahooDaily(symbol, '1y')) {
      byDate.set(d.date, (byDate.get(d.date) ?? 0) + d.volume * size * d.close)
    }
  }
  return [...byDate.entries()]
    .map(([date, value]) => ({ date, value }))
    .filter((p) => p.date >= fromDate)
    .sort((a, b) => a.date.localeCompare(b.date))
}

/** Front-month close, for basis calcs. */
export async function cmeFrontMonthClose(asset: Asset): Promise<number | null> {
  const days = await yahooDaily(CONTRACTS[asset][0].symbol, '5d')
  return days[days.length - 1]?.close ?? null
}

/** Daily front-month closes over the past year, for basis history. */
export async function cmeCloseHistory(asset: Asset, fromDate: string): Promise<Map<string, number>> {
  const days = await yahooDaily(CONTRACTS[asset][0].symbol, '1y')
  const closes = new Map<string, number>()
  for (const d of days) if (d.date >= fromDate) closes.set(d.date, d.close)
  return closes
}
