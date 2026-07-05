import { fetchJson } from '../fetch'
import { Asset } from '../types'

// Spot reference prices from Coinbase Exchange (public, US-accessible).
// Used as the index for basis calculations and to dollarize contract counts.

const EXCHANGE = 'https://api.exchange.coinbase.com'

const PRODUCTS: Record<Asset, string> = { BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD' }

export async function spotPrice(asset: Asset): Promise<number> {
  return spotPriceSymbol(PRODUCTS[asset])
}

/** Spot price for any Coinbase Exchange product (e.g. 'XRP-USD'). */
export async function spotPriceSymbol(product: string): Promise<number> {
  const t = await fetchJson<{ price: string }>(`${EXCHANGE}/products/${product}/ticker`)
  return parseFloat(t.price)
}

/** Daily UTC closes since fromDate. Coinbase returns ≤300 candles per call, so page by window. */
export async function spotCloseHistory(asset: Asset, fromDate: string): Promise<Map<string, number>> {
  return spotCloseHistorySymbol(PRODUCTS[asset], fromDate)
}

/** Hourly closes (ms timestamp → close) for any Coinbase Exchange product. ≤300 candles/call. */
export async function spotHourlyCloses(product: string, fromDate: string): Promise<Map<number, number>> {
  const closes = new Map<number, number>()
  const HOUR = 3_600_000
  let start = new Date(`${fromDate}T00:00:00Z`).getTime()
  const now = Date.now()
  while (start < now) {
    const end = Math.min(start + 299 * HOUR, now)
    const url = `${EXCHANGE}/products/${product}/candles?granularity=3600&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`
    const rows = await fetchJson<[number, number, number, number, number, number][]>(url)
    for (const r of rows) closes.set(r[0] * 1000, r[4])
    start = end + HOUR
  }
  return closes
}

/** Daily closes for any Coinbase Exchange product (e.g. 'BCH-USD'). */
export async function spotCloseHistorySymbol(product: string, fromDate: string): Promise<Map<string, number>> {
  const closes = new Map<string, number>()
  const DAY = 86_400_000
  let start = new Date(`${fromDate}T00:00:00Z`).getTime()
  const now = Date.now()
  while (start < now) {
    const end = Math.min(start + 299 * DAY, now)
    const url = `${EXCHANGE}/products/${product}/candles?granularity=86400&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`
    // rows: [time, low, high, open, close, volume], newest first
    const rows = await fetchJson<[number, number, number, number, number, number][]>(url)
    for (const r of rows) closes.set(new Date(r[0] * 1000).toISOString().slice(0, 10), r[4])
    start = end + DAY
  }
  return closes
}
