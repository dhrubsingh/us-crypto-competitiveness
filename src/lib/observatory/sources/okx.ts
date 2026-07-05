import { fetchJson } from '../fetch'
import { Asset } from '../types'
import { DailyPoint, VenueSnapshot, NormalizedBook, toDailyDate } from './common'

// OKX USDT swaps. Reachable directly from US IPs — no relay needed.

const V5 = 'https://www.okx.com/api/v5'

const INST: Record<Asset, string> = {
  BTC: 'BTC-USDT-SWAP',
  ETH: 'ETH-USDT-SWAP',
  SOL: 'SOL-USDT-SWAP',
}

interface OkxResponse<T> {
  code: string
  msg: string
  data: T
}

async function okx<T>(path: string): Promise<T> {
  const res = await fetchJson<OkxResponse<T>>(`${V5}${path}`)
  if (res.code !== '0') throw new Error(`okx ${path}: ${res.msg}`)
  return res.data
}

export async function okxSnapshot(asset: Asset): Promise<VenueSnapshot> {
  const instId = INST[asset]
  const [tickers, oi, funding, books] = await Promise.all([
    okx<{ last: string; volCcy24h: string }[]>(`/market/ticker?instId=${instId}`),
    okx<{ oiUsd: string }[]>(`/public/open-interest?instId=${instId}`),
    okx<{ fundingRate: string; fundingTime: string; nextFundingTime: string }[]>(
      `/public/funding-rate?instId=${instId}`
    ),
    okx<{ bids: string[][]; asks: string[][] }[]>(`/market/books?instId=${instId}&sz=400`),
  ])
  const last = parseFloat(tickers[0].last)
  const f = funding[0]
  // OKX funding intervals vary per instrument; normalize to 8h using the gap
  // between the current and next funding times (falls back to 8h).
  const intervalMs = parseInt(f.nextFundingTime, 10) - parseInt(f.fundingTime, 10)
  const intervalH = intervalMs > 0 ? intervalMs / 3_600_000 : 8
  const rate8h = parseFloat(f.fundingRate) * (8 / intervalH) * 100
  // books levels are [price, contracts, ...]; contract size is 0.01 BTC / 0.1 ETH / 1 SOL for USDT swaps
  const CONTRACT_SIZE: Record<Asset, number> = { BTC: 0.01, ETH: 0.1, SOL: 1 }
  const cs = CONTRACT_SIZE[asset]
  const book: NormalizedBook = {
    bids: books[0].bids.map((l) => [parseFloat(l[0]), parseFloat(l[1]) * cs]),
    asks: books[0].asks.map((l) => [parseFloat(l[0]), parseFloat(l[1]) * cs]),
  }
  return {
    venue: 'okx',
    asset,
    volumeUsd24h: parseFloat(tickers[0].volCcy24h) * last,
    oiUsd: parseFloat(oi[0].oiUsd),
    rate8hPct: rate8h,
    markPrice: last,
    instrument: instId,
    book,
  }
}

// --- backfill ---------------------------------------------------------------

/** Daily quote-USD volume from history candles (100 rows/page, paginate with `after`). */
export async function okxVolumeHistory(asset: Asset, fromDate: string): Promise<DailyPoint[]> {
  const instId = INST[asset]
  const out: DailyPoint[] = []
  const fromTs = new Date(`${fromDate}T00:00:00Z`).getTime()
  let after = ''
  for (let page = 0; page < 12; page++) {
    const rows = await okx<string[][]>(
      `/market/history-candles?instId=${instId}&bar=1Dutc&limit=100${after ? `&after=${after}` : ''}`
    )
    if (!rows.length) break
    for (const r of rows) {
      // [ts, o, h, l, c, vol(contracts), volCcy(base), volCcyQuote(quote USD), confirm]
      out.push({ date: toDailyDate(parseInt(r[0], 10)), value: parseFloat(r[7]) })
    }
    const oldest = parseInt(rows[rows.length - 1][0], 10)
    if (oldest < fromTs) break
    after = String(oldest)
  }
  return out.filter((p) => p.date >= fromDate).sort((a, b) => a.date.localeCompare(b.date))
}

/** Asset-wide OKX contract OI history in USD from the rubik stats endpoint. */
export async function okxOiHistory(asset: Asset, fromDate: string): Promise<DailyPoint[]> {
  const rows = await okx<string[][]>(
    `/rubik/stat/contracts/open-interest-volume?ccy=${asset}&period=1D`
  )
  // rows: [ts, oi(USD), vol(USD)] — most recent first
  return rows
    .map((r) => ({ date: toDailyDate(parseInt(r[0], 10)), value: parseFloat(r[1]) }))
    .filter((p) => p.date >= fromDate)
    .sort((a, b) => a.date.localeCompare(b.date))
}

/** Daily mean funding, 8h-normalized %. */
export async function okxFundingHistory(asset: Asset, fromDate: string): Promise<DailyPoint[]> {
  const instId = INST[asset]
  const byDate = new Map<string, number[]>()
  const fromTs = new Date(`${fromDate}T00:00:00Z`).getTime()
  let before = ''
  for (let page = 0; page < 40; page++) {
    const rows = await okx<{ fundingRate: string; fundingTime: string }[]>(
      `/public/funding-rate-history?instId=${instId}&limit=100${before ? `&after=${before}` : ''}`
    )
    if (!rows.length) break
    for (const r of rows) {
      const date = toDailyDate(parseInt(r.fundingTime, 10))
      if (!byDate.has(date)) byDate.set(date, [])
      byDate.get(date)!.push(parseFloat(r.fundingRate))
    }
    const oldest = parseInt(rows[rows.length - 1].fundingTime, 10)
    if (oldest < fromTs) break
    before = String(oldest)
  }
  // OKX BTC/ETH/SOL USDT swaps fund every 8h, so daily mean of the raw rate is already 8h-equivalent
  return [...byDate.entries()]
    .map(([date, rates]) => ({ date, value: (rates.reduce((a, b) => a + b, 0) / rates.length) * 100 }))
    .filter((p) => p.date >= fromDate)
    .sort((a, b) => a.date.localeCompare(b.date))
}
