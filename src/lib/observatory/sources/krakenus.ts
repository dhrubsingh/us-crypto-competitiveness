import { fetchJson } from '../fetch'
import { Asset } from '../types'
import { DailyPoint, VenueSnapshot } from './common'
import { spotPrice } from './spot'

// Kraken's onshore US derivatives venue: Bitnomial Exchange, the CFTC
// DCM/DCO/FCM acquired by Kraken's parent in April 2026, which lists the
// perpetual contracts traded through Kraken Pro. Bitnomial's REST API is
// public and unauthenticated. Prices come back in scaled exchange points, so
// open interest is dollarized with the observatory's spot reference instead;
// notional volume is already USD. No public order book (market data beyond
// stats requires direct market access).

const API = 'https://bitnomial.com/exchange/api/v1/prod'
const FUNDING = 'https://bitnomial.com/exchange/api/v1/funding-rates/'

// Perp product names follow 'Perpetual <Asset> US Dollar <Size> Future'.
// startsWith keeps Bitcoin Cash ('Perpetual Bitcoin Cash US…') out of BTC.
const NAME_PREFIX: Record<Asset, string> = {
  BTC: 'Perpetual Bitcoin US Dollar',
  ETH: 'Perpetual Ethereum US Dollar',
  SOL: 'Perpetual Solana US Dollar',
}

interface BitnomialSpec {
  product_id: number
  product_name: string
  product_status: string
  type?: string
  contract_size: number
  contract_size_unit: string
}

interface BitnomialData {
  product_id: number
  notional_volume: number | null
  open_interest: number | null
}

let catalogCache: { specs: BitnomialSpec[]; data: Map<number, BitnomialData>; ts: number } | null = null

async function catalog() {
  if (catalogCache && Date.now() - catalogCache.ts < 5 * 60_000) return catalogCache
  const [specs, data] = await Promise.all([
    fetchJson<BitnomialSpec[]>(`${API}/product/specs/`),
    fetchJson<BitnomialData[]>(`${API}/product/data/`),
  ])
  catalogCache = { specs, data: new Map(data.map((d) => [d.product_id, d])), ts: Date.now() }
  return catalogCache
}

function activePerps(specs: BitnomialSpec[], asset: Asset): BitnomialSpec[] {
  return specs.filter(
    (s) =>
      s.product_status === 'active' &&
      (s.type === 'perpetual' || s.product_name.startsWith('Perpetual')) &&
      s.product_name.startsWith(NAME_PREFIX[asset])
  )
}

export async function krakenUsSnapshot(asset: Asset): Promise<VenueSnapshot | null> {
  const { specs, data } = await catalog()
  const perps = activePerps(specs, asset)
  if (!perps.length) return null

  const spot = await spotPrice(asset)

  let volumeUsd = 0
  let oiUsd = 0
  for (const p of perps) {
    const d = data.get(p.product_id)
    volumeUsd += d?.notional_volume ?? 0
    oiUsd += (d?.open_interest ?? 0) * p.contract_size * spot
  }

  // Funding settles on 8h intervals; funding_rate is the per-interval rate
  let rate8hPct: number | null = null
  try {
    const res = await fetchJson<{ data: { funding_rate: number }[] }>(
      `${FUNDING}?product_id=${perps[0].product_id}`
    )
    const latest = res.data?.[0]
    if (latest) rate8hPct = latest.funding_rate * 100
  } catch {
    // funding optional
  }

  return {
    venue: 'kraken_us',
    asset,
    volumeUsd24h: volumeUsd || null,
    oiUsd,
    rate8hPct,
    markPrice: null, // exchange reports scaled points, not dollars
    instrument: perps[0].product_name,
    book: null, // order book requires direct market access
  }
}

/** Daily mean funding (8h-equivalent %) since `fromDate` (history starts at 2026 launch). */
export async function krakenUsFundingHistory(asset: Asset, fromDate: string): Promise<DailyPoint[]> {
  const { specs } = await catalog()
  const perps = activePerps(specs, asset)
  if (!perps.length) return []

  interface FundingPage {
    pagination?: { cursor?: string }
    data: { funding_rate: number; interval_start: string }[]
  }
  const byDate = new Map<string, number[]>()
  let cursor: string | null = null
  for (let page = 0; page < 12; page++) {
    // response cursors arrive already URL-encoded — do not re-encode
    const url: string =
      `${FUNDING}?product_id=${perps[0].product_id}&begin_time=${fromDate}T00:00:00Z` +
      (cursor ? `&cursor=${cursor}` : '')
    const res: FundingPage = await fetchJson<FundingPage>(url)
    if (!res.data?.length) break
    for (const r of res.data) {
      const date = r.interval_start.slice(0, 10)
      if (date < fromDate) continue
      if (!byDate.has(date)) byDate.set(date, [])
      byDate.get(date)!.push(r.funding_rate)
    }
    if (!res.pagination?.cursor || res.pagination.cursor === cursor) break
    cursor = res.pagination.cursor
  }
  return [...byDate.entries()]
    .map(([date, xs]) => ({ date, value: (xs.reduce((a, b) => a + b, 0) / xs.length) * 100 }))
    .sort((a, b) => a.date.localeCompare(b.date))
}
