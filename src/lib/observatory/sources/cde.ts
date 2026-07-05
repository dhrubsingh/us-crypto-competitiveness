import { fetchJson } from '../fetch'
import { Asset } from '../types'
import { DailyPoint, VenueSnapshot, NormalizedBook, toDailyDate } from './common'
import { spotHourlyCloses } from './spot'

// Coinbase Derivatives Exchange (CFTC-regulated DCM). Public market data via
// the unauthenticated Coinbase Advanced Trade /market endpoints. Volume sums
// every listed CDE contract per asset (dated + perp-style); funding and the
// order book come from the perp-style contract (long-dated future with an
// hourly funding mechanism). No public OI — that comes weekly from CFTC COT.

const BASE = 'https://api.coinbase.com/api/v3/brokerage/market'

interface CDEProduct {
  product_id: string
  display_name: string
  price: string
  volume_24h: string
  trading_disabled: boolean
  is_disabled: boolean
  future_product_details?: {
    venue?: string
    contract_root_unit?: string
    contract_size?: string
    funding_rate?: string
    funding_interval?: string
  }
}

let catalogCache: { products: CDEProduct[]; ts: number } | null = null

async function cdeProducts(): Promise<CDEProduct[]> {
  if (catalogCache && Date.now() - catalogCache.ts < 5 * 60_000) return catalogCache.products
  const { products } = await fetchJson<{ products: CDEProduct[] }>(
    `${BASE}/products?product_type=FUTURE&limit=250`
  )
  const cde = products.filter((p) => p.future_product_details?.venue === 'cde')
  catalogCache = { products: cde, ts: Date.now() }
  return cde
}

export async function cdeSnapshot(asset: Asset): Promise<VenueSnapshot> {
  const products = (await cdeProducts()).filter(
    (p) => p.future_product_details?.contract_root_unit === asset && !p.trading_disabled && !p.is_disabled
  )
  if (!products.length) throw new Error(`cde: no live ${asset} products`)

  let volumeUsd = 0
  for (const p of products) {
    const contracts = parseFloat(p.volume_24h)
    const size = parseFloat(p.future_product_details?.contract_size ?? '')
    const price = parseFloat(p.price)
    if (Number.isFinite(contracts) && Number.isFinite(size) && Number.isFinite(price)) {
      volumeUsd += contracts * size * price
    }
  }

  const perp = products.find((p) => p.display_name.toUpperCase().includes('PERP'))
  let rate8hPct: number | null = null
  let mark: number | null = null
  let book: NormalizedBook | null = null

  if (perp) {
    mark = parseFloat(perp.price) || null
    const rate = parseFloat(perp.future_product_details?.funding_rate ?? '')
    const intervalS = parseFloat((perp.future_product_details?.funding_interval ?? '').replace(/s$/, ''))
    if (Number.isFinite(rate) && intervalS > 0) {
      rate8hPct = rate * 100 * (8 / (intervalS / 3600))
    }
    const size = parseFloat(perp.future_product_details?.contract_size ?? '1')
    const { pricebook } = await fetchJson<{
      pricebook: { bids: { price: string; size: string }[]; asks: { price: string; size: string }[] }
    }>(`${BASE}/product_book?product_id=${perp.product_id}&limit=100`)
    book = {
      bids: pricebook.bids.map((l) => [parseFloat(l.price), parseFloat(l.size) * size]),
      asks: pricebook.asks.map((l) => [parseFloat(l.price), parseFloat(l.size) * size]),
    }
  }

  return {
    venue: 'cde',
    asset,
    volumeUsd24h: volumeUsd || null,
    oiUsd: null, // weekly, from CFTC COT
    rate8hPct,
    markPrice: mark,
    instrument: perp?.product_id ?? products[0].product_id,
    book,
  }
}

// --- backfill ---------------------------------------------------------------

interface CDECandle {
  start: string // unix seconds
  close: string
  volume: string // contracts
}

const SPOT_PRODUCT: Record<Asset, string> = { BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD' }

/**
 * Estimated CDE perp funding history, reconstructed from the perp–spot
 * premium. CDE publishes no funding history, but it publishes the formula
 * (help.coinbase.com, "US Perpetual-Style Futures Funding Rate Mechanism"):
 * the hourly rate is the hour's average premium vs the spot index scaled down
 * by 24, EMA-smoothed (α = 0.75). We recompute it from hourly candle closes:
 * hourly premium = (perp close − spot close) / spot close, hourly rate ≈
 * premium / 24, daily mean → 8h-equivalent = mean premium / 3. Sampling once
 * an hour (Coinbase samples every 3 minutes) makes this an estimate; rows are
 * labeled `premium-reconstruction` in the dataset.
 */
export async function cdeFundingHistoryEstimate(asset: Asset, fromDate: string): Promise<DailyPoint[]> {
  const products = (await cdeProducts()).filter(
    (p) => p.future_product_details?.contract_root_unit === asset && !p.is_disabled
  )
  const perp = products.find((p) => p.display_name.toUpperCase().includes('PERP'))
  if (!perp) return []

  const spot = await spotHourlyCloses(SPOT_PRODUCT[asset], fromDate)

  const byDate = new Map<string, number[]>()
  const endTs = Math.floor(Date.now() / 1000)
  const fromTs = Math.floor(new Date(`${fromDate}T00:00:00Z`).getTime() / 1000)
  for (let s = fromTs; s < endTs; s += 349 * 3600) {
    const e = Math.min(s + 349 * 3600, endTs)
    let candles: CDECandle[] = []
    try {
      const res = await fetchJson<{ candles: CDECandle[] }>(
        `${BASE}/products/${perp.product_id}/candles?start=${s}&end=${e}&granularity=ONE_HOUR`
      )
      candles = res.candles ?? []
    } catch {
      continue
    }
    for (const c of candles) {
      const ts = parseInt(c.start, 10) * 1000
      const spotClose = spot.get(ts)
      const perpClose = parseFloat(c.close)
      if (!spotClose || !Number.isFinite(perpClose)) continue
      const premium = (perpClose - spotClose) / spotClose
      // discard prints further than 1% from spot — stale/erroneous trades, not premium
      if (Math.abs(premium) > 0.01) continue
      const date = toDailyDate(ts)
      if (!byDate.has(date)) byDate.set(date, [])
      byDate.get(date)!.push(premium)
    }
  }

  return [...byDate.entries()]
    .filter(([, xs]) => xs.length >= 6) // need a reasonable sample of the day
    .map(([date, xs]) => {
      const meanPremium = xs.reduce((a, b) => a + b, 0) / xs.length
      return { date, value: (meanPremium / 3) * 100 } // 8h-equivalent, percent
    })
    .sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Daily USD volume summed across every currently-listed CDE contract for the
 * asset, from the public candles endpoint (contracts × contract size ×
 * close). Coinbase stops serving contracts once they expire, so dated
 * contracts that expired before today are missing from older months — the
 * perp-style contract, which carries most CDE volume, is complete from its
 * July 2025 listing.
 */
export async function cdeVolumeHistory(asset: Asset, fromDate: string): Promise<DailyPoint[]> {
  const products = (await cdeProducts()).filter(
    (p) => p.future_product_details?.contract_root_unit === asset && !p.is_disabled
  )
  const byDate = new Map<string, number>()
  const endTs = Math.floor(Date.now() / 1000)
  const fromTs = Math.floor(new Date(`${fromDate}T00:00:00Z`).getTime() / 1000)

  for (const p of products) {
    const size = parseFloat(p.future_product_details?.contract_size ?? '')
    if (!Number.isFinite(size)) continue
    // candles come back ≤350 per call; page in ~300-day windows
    for (let start = fromTs; start < endTs; start += 300 * 86_400) {
      const end = Math.min(start + 300 * 86_400, endTs)
      try {
        const { candles } = await fetchJson<{ candles: CDECandle[] }>(
          `${BASE}/products/${p.product_id}/candles?start=${start}&end=${end}&granularity=ONE_DAY`
        )
        for (const c of candles ?? []) {
          const date = toDailyDate(parseInt(c.start, 10) * 1000)
          const notional = parseFloat(c.volume) * size * parseFloat(c.close)
          if (!Number.isFinite(notional)) continue
          byDate.set(date, (byDate.get(date) ?? 0) + notional)
        }
      } catch {
        // some contracts have no candles for older windows — skip quietly
      }
    }
  }
  return [...byDate.entries()]
    .map(([date, value]) => ({ date, value }))
    .filter((p) => p.date >= fromDate)
    .sort((a, b) => a.date.localeCompare(b.date))
}
