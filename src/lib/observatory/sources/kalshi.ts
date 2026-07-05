import { fetchJson } from '../fetch'
import { Asset } from '../types'
import { DailyPoint, VenueSnapshot, NormalizedBook, toDailyDate } from './common'

// Kalshi perpetual futures (CFTC-approved, launched 2026). Market data is
// public and unauthenticated on the margin API. Contracts are tiny fractions
// of a coin (e.g. 0.0001 BTC), so prices are converted to an implied coin
// price via contract_size for basis/depth comparison.

const API = 'https://external-api.kalshi.com/trade-api/v2/margin'

const TICKERS: Record<Asset, string> = {
  BTC: 'KXBTCPERP',
  ETH: 'KXETHPERP',
  SOL: 'KXSOLPERP',
}

interface KalshiPerpMarket {
  ticker: string
  status: string
  contract_size: string
  price: string
  open_interest_notional_value_dollars: string
  volume_24h_notional_value_dollars: string
}

async function perpMarket(asset: Asset): Promise<KalshiPerpMarket | null> {
  const { markets } = await fetchJson<{ markets: KalshiPerpMarket[] }>(`${API}/markets`)
  return markets.find((mk) => mk.ticker === TICKERS[asset]) ?? null
}

export async function kalshiSnapshot(asset: Asset): Promise<VenueSnapshot | null> {
  const m = await perpMarket(asset)
  if (!m || m.status !== 'active') return null

  const contractSize = parseFloat(m.contract_size)
  const impliedPrice = parseFloat(m.price) / contractSize

  // Order book: [[price, contracts], ...] ordered worst→best on both sides.
  // Prices are per-contract dollars; normalize to implied coin price + coin size.
  let book: NormalizedBook | null = null
  try {
    const { orderbook } = await fetchJson<{
      orderbook: { bids?: [string, string][]; asks?: [string, string][] }
    }>(`${API}/markets/${m.ticker}/orderbook`)
    const toLevels = (side: [string, string][] | undefined): [number, number][] =>
      (side ?? []).map(([p, q]) => [parseFloat(p) / contractSize, parseFloat(q) * contractSize])
    const bids = toLevels(orderbook.bids).sort((a, b) => b[0] - a[0])
    const asks = toLevels(orderbook.asks).sort((a, b) => a[0] - b[0])
    if (bids.length && asks.length) book = { bids, asks }
  } catch {
    // book optional — snapshot still useful without it
  }

  // Funding settles every 8h; funding_rate is already the per-period rate
  let rate8hPct: number | null = null
  try {
    const fr = await fetchJson<{ funding_rates: { funding_rate: number }[] }>(
      `${API}/funding_rates/historical?ticker=${m.ticker}&limit=1`
    )
    const latest = fr.funding_rates?.[0]
    if (latest) rate8hPct = latest.funding_rate * 100
  } catch {
    // funding optional
  }

  return {
    venue: 'kalshi',
    asset,
    volumeUsd24h: parseFloat(m.volume_24h_notional_value_dollars),
    oiUsd: parseFloat(m.open_interest_notional_value_dollars),
    rate8hPct,
    markPrice: impliedPrice,
    instrument: m.ticker,
    book,
  }
}

interface KalshiCandle {
  end_period_ts: number
  volume_notional_value_dollars?: string
  open_interest_notional_value_dollars?: string
}

async function dailyCandles(asset: Asset, fromDate: string): Promise<KalshiCandle[]> {
  const startTs = Math.floor(new Date(`${fromDate}T00:00:00Z`).getTime() / 1000)
  const endTs = Math.floor(Date.now() / 1000)
  try {
    const res = await fetchJson<{ candlesticks: KalshiCandle[] }>(
      `${API}/markets/${TICKERS[asset]}/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=1440`
    )
    return res.candlesticks ?? []
  } catch {
    return [] // series may not exist yet for this asset
  }
}

/** Daily notional volume (history starts at each perp's 2026 launch). */
export async function kalshiVolumeHistory(asset: Asset, fromDate: string): Promise<DailyPoint[]> {
  return (await dailyCandles(asset, fromDate))
    .filter((c) => c.volume_notional_value_dollars != null)
    .map((c) => ({
      date: toDailyDate(c.end_period_ts * 1000),
      value: parseFloat(c.volume_notional_value_dollars!),
    }))
    .filter((p) => p.date >= fromDate && Number.isFinite(p.value))
}

/** Daily mean funding (8h rate %, as published) since fromDate, cursor-paginated. */
export async function kalshiFundingHistory(asset: Asset, fromDate: string): Promise<DailyPoint[]> {
  const ticker = TICKERS[asset]
  const byDate = new Map<string, number[]>()
  let cursor: string | null = null
  for (let page = 0; page < 20; page++) {
    const url =
      `${API}/funding_rates/historical?ticker=${ticker}&limit=100` + (cursor ? `&cursor=${cursor}` : '')
    let res: { funding_rates: { funding_rate: number; funding_time: string }[]; cursor?: string }
    try {
      res = await fetchJson(url)
    } catch {
      break // series may not exist for this asset yet
    }
    const rows = res.funding_rates ?? []
    if (!rows.length) break
    let oldest = '9999'
    for (const r of rows) {
      const date = r.funding_time.slice(0, 10)
      oldest = date < oldest ? date : oldest
      if (date < fromDate) continue
      if (!byDate.has(date)) byDate.set(date, [])
      byDate.get(date)!.push(r.funding_rate)
    }
    if (oldest < fromDate || !res.cursor || res.cursor === cursor) break
    cursor = res.cursor
  }
  return [...byDate.entries()]
    .map(([date, xs]) => ({ date, value: (xs.reduce((a, b) => a + b, 0) / xs.length) * 100 }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

/** Daily open interest notional. */
export async function kalshiOiHistory(asset: Asset, fromDate: string): Promise<DailyPoint[]> {
  return (await dailyCandles(asset, fromDate))
    .filter((c) => c.open_interest_notional_value_dollars != null)
    .map((c) => ({
      date: toDailyDate(c.end_period_ts * 1000),
      value: parseFloat(c.open_interest_notional_value_dollars!),
    }))
    .filter((p) => p.date >= fromDate && Number.isFinite(p.value))
}
