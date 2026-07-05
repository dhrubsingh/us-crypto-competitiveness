import { fetchJson } from '../fetch'
import { VenueId } from '../types'
import { spotPriceSymbol, spotCloseHistorySymbol } from './spot'

// Venue-wide totals: every listed derivative contract on each venue — all
// crypto pairs plus whatever else the venue lists (RWA, equity-index and
// commodity perps/futures). This is the "everything listed" scope, alongside
// the per-asset BTC/ETH/SOL series. Volume everywhere comes from bulk public
// endpoints; open interest likewise except Binance, which has no bulk OI
// endpoint — its venue-wide OI comes from CoinGecko's derivatives page for
// Binance Futures (the one non-direct source, documented on the methodology
// page).

export interface VenueTotals {
  venue: VenueId
  volumeUsd: number | null
  oiUsd: number | null
  source: string
}

async function binanceTotals(): Promise<VenueTotals> {
  const tickers = await fetchJson<{ quoteVolume: string }[]>(
    'https://fapi.binance.com/fapi/v1/ticker/24hr'
  )
  const volumeUsd = tickers.reduce((s, t) => s + (parseFloat(t.quoteVolume) || 0), 0)
  let oiUsd: number | null = null
  try {
    const cg = await fetchJson<{ open_interest_btc: number }>(
      'https://api.coingecko.com/api/v3/derivatives/exchanges/binance_futures'
    )
    const btc = await spotPriceSymbol('BTC-USD')
    oiUsd = cg.open_interest_btc * btc
  } catch {
    // OI optional; volume is the primary series
  }
  return { venue: 'binance', volumeUsd, oiUsd, source: 'binance-fapi + coingecko-oi' }
}

async function bybitTotals(): Promise<VenueTotals> {
  let volumeUsd = 0
  let oiUsd = 0
  for (const category of ['linear', 'inverse']) {
    const res = await fetchJson<{
      result: { list: { turnover24h: string; openInterestValue: string }[] }
    }>(`https://api.bybit.com/v5/market/tickers?category=${category}`)
    for (const t of res.result.list) {
      volumeUsd += parseFloat(t.turnover24h) || 0
      oiUsd += parseFloat(t.openInterestValue) || 0
    }
  }
  return { venue: 'bybit', volumeUsd, oiUsd, source: 'bybit-v5' }
}

async function okxTotals(): Promise<VenueTotals> {
  let volumeUsd = 0
  let oiUsd = 0
  for (const instType of ['SWAP', 'FUTURES']) {
    const tickers = await fetchJson<{ data: { last: string; volCcy24h: string }[] }>(
      `https://www.okx.com/api/v5/market/tickers?instType=${instType}`
    )
    for (const t of tickers.data) {
      const v = (parseFloat(t.volCcy24h) || 0) * (parseFloat(t.last) || 0)
      if (Number.isFinite(v)) volumeUsd += v
    }
    const oi = await fetchJson<{ data: { oiUsd: string }[] }>(
      `https://www.okx.com/api/v5/public/open-interest?instType=${instType}`
    )
    for (const r of oi.data) oiUsd += parseFloat(r.oiUsd) || 0
  }
  return { venue: 'okx', volumeUsd, oiUsd, source: 'okx-v5' }
}

async function deribitTotals(): Promise<VenueTotals> {
  let volumeUsd = 0
  let oiUsd = 0
  for (const currency of ['BTC', 'ETH', 'USDC', 'USDT']) {
    const res = await fetchJson<{
      result: { volume_usd?: number; open_interest?: number; mark_price?: number }[]
    }>(`https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${currency}&kind=future`)
    for (const s of res.result) {
      volumeUsd += s.volume_usd ?? 0
      const oi = s.open_interest ?? 0
      // BTC/ETH contracts are inverse (OI already USD); USDC/USDT are linear (OI in base units)
      oiUsd += currency === 'BTC' || currency === 'ETH' ? oi : oi * (s.mark_price ?? 0)
    }
  }
  return { venue: 'deribit', volumeUsd, oiUsd, source: 'deribit-api' }
}

async function hyperliquidTotals(): Promise<VenueTotals> {
  const res = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`hyperliquid HTTP ${res.status}`)
  const [, ctxs] = (await res.json()) as [unknown, { dayNtlVlm: string; openInterest: string; markPx: string }[]]
  let volumeUsd = 0
  let oiUsd = 0
  for (const c of ctxs) {
    volumeUsd += parseFloat(c.dayNtlVlm) || 0
    oiUsd += (parseFloat(c.openInterest) || 0) * (parseFloat(c.markPx) || 0)
  }
  return { venue: 'hyperliquid', volumeUsd, oiUsd, source: 'hyperliquid-api' }
}

async function krakenTotals(): Promise<VenueTotals> {
  const { tickers } = await fetchJson<{
    tickers: { symbol: string; volumeQuote?: number; openInterest?: number; markPrice?: number }[]
  }>('https://futures.kraken.com/derivatives/api/v3/tickers')
  let volumeUsd = 0
  let oiUsd = 0
  for (const t of tickers) {
    volumeUsd += t.volumeQuote ?? 0
    const oi = t.openInterest ?? 0
    oiUsd += /^(PI|FI)_/i.test(t.symbol) ? oi : oi * (t.markPrice ?? 0)
  }
  return { venue: 'kraken', volumeUsd, oiUsd, source: 'kraken-v3' }
}

// CME's full crypto futures suite on the public delayed feed (standard +
// micro where Yahoo carries the symbol). Contract units from CME specs.
const CME_TOTAL_CONTRACTS: { symbol: string; size: number }[] = [
  { symbol: 'BTC=F', size: 5 },
  { symbol: 'MBT=F', size: 0.1 },
  { symbol: 'ETH=F', size: 50 },
  { symbol: 'MET=F', size: 0.1 },
  { symbol: 'SOL=F', size: 500 },
  { symbol: 'MSL=F', size: 25 },
  { symbol: 'XRP=F', size: 50_000 },
]

async function cmeTotals(): Promise<VenueTotals> {
  const today = new Date().toISOString().slice(0, 10)
  let volumeUsd = 0
  for (const { symbol, size } of CME_TOTAL_CONTRACTS) {
    try {
      const data = await fetchJson<{
        chart: {
          result: {
            timestamp: number[]
            indicators: { quote: { volume: (number | null)[]; close: (number | null)[] }[] }
          }[]
        }
      }>(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`)
      const r = data.chart.result?.[0]
      if (!r?.timestamp) continue
      const { volume, close } = r.indicators.quote[0]
      // last completed session (in-progress sessions badly understate the day)
      for (let i = r.timestamp.length - 1; i >= 0; i--) {
        const date = new Date(r.timestamp[i] * 1000).toISOString().slice(0, 10)
        if (date >= today || volume[i] == null || close[i] == null) continue
        volumeUsd += volume[i]! * size * close[i]!
        break
      }
    } catch {
      // per-symbol failures don't sink the total
    }
  }
  return { venue: 'cme', volumeUsd: volumeUsd || null, oiUsd: null, source: 'yahoo-front-month' }
}

async function cdeTotals(): Promise<VenueTotals> {
  const { products } = await fetchJson<{
    products: {
      price: string
      volume_24h: string
      is_disabled: boolean
      future_product_details?: { venue?: string; contract_size?: string }
    }[]
  }>('https://api.coinbase.com/api/v3/brokerage/market/products?product_type=FUTURE&limit=250')
  let volumeUsd = 0
  for (const p of products) {
    if (p.future_product_details?.venue !== 'cde' || p.is_disabled) continue
    const v =
      (parseFloat(p.volume_24h) || 0) *
      (parseFloat(p.future_product_details?.contract_size ?? '') || 0) *
      (parseFloat(p.price) || 0)
    if (Number.isFinite(v)) volumeUsd += v
  }
  return { venue: 'cde', volumeUsd: volumeUsd || null, oiUsd: null, source: 'coinbase-api' }
}

async function kalshiTotals(): Promise<VenueTotals> {
  const { markets } = await fetchJson<{
    markets: {
      status: string
      volume_24h_notional_value_dollars: string
      open_interest_notional_value_dollars: string
    }[]
  }>('https://external-api.kalshi.com/trade-api/v2/margin/markets')
  let volumeUsd = 0
  let oiUsd = 0
  for (const m of markets) {
    if (m.status !== 'active') continue
    volumeUsd += parseFloat(m.volume_24h_notional_value_dollars) || 0
    oiUsd += parseFloat(m.open_interest_notional_value_dollars) || 0
  }
  return { venue: 'kalshi', volumeUsd, oiUsd, source: 'kalshi-api' }
}

async function krakenUsTotals(): Promise<VenueTotals> {
  const [specs, data] = await Promise.all([
    fetchJson<{ product_id: number; product_status: string; type?: string; product_name: string }[]>(
      'https://bitnomial.com/exchange/api/v1/prod/product/specs/'
    ),
    fetchJson<{ product_id: number; notional_volume: number | null }[]>(
      'https://bitnomial.com/exchange/api/v1/prod/product/data/'
    ),
  ])
  const byId = new Map(data.map((d) => [d.product_id, d]))
  let volumeUsd = 0
  for (const s of specs) {
    if (s.product_status !== 'active' || (s.type !== 'perpetual' && s.type !== 'future')) continue
    volumeUsd += byId.get(s.product_id)?.notional_volume ?? 0
  }
  // Venue-wide OI needs per-root dollarization (scaled point prices); the
  // majors OI from the daily snapshot covers nearly all of it — left null here
  return { venue: 'kraken_us', volumeUsd: volumeUsd || null, oiUsd: null, source: 'bitnomial-api' }
}

export async function allVenueTotals(): Promise<VenueTotals[]> {
  const fns = [
    binanceTotals,
    bybitTotals,
    okxTotals,
    deribitTotals,
    hyperliquidTotals,
    krakenTotals,
    cmeTotals,
    cdeTotals,
    kalshiTotals,
    krakenUsTotals,
  ]
  const out: VenueTotals[] = []
  for (const fn of fns) {
    try {
      out.push(await fn())
    } catch (err) {
      console.error(`[totals] ${fn.name}: ${err instanceof Error ? err.message : err}`)
    }
  }
  return out
}

// --- CFTC weekly onshore totals ---------------------------------------------

// Beyond the BTC/ETH/SOL contracts already tracked, the CFTC also reports
// XRP and BCH contracts at CME and Coinbase Derivatives. Units from CME specs
// and the CDE product catalog (contract_size).
const CFTC_EXTRA: Record<string, { venue: 'cme' | 'cde'; spot: string; unit: number }> = {
  'XRP - CHICAGO MERCANTILE EXCHANGE': { venue: 'cme', spot: 'XRP-USD', unit: 50_000 },
  'MICRO XRP - CHICAGO MERCANTILE EXCHANGE': { venue: 'cme', spot: 'XRP-USD', unit: 2_500 },
  'NANO XRP - COINBASE DERIVATIVES, LLC': { venue: 'cde', spot: 'XRP-USD', unit: 500 },
  'NANO XRP PERP STYLE - COINBASE DERIVATIVES, LLC': { venue: 'cde', spot: 'XRP-USD', unit: 500 },
  'BITCOIN CASH PERP STYLE - COINBASE DERIVATIVES, LLC': { venue: 'cde', spot: 'BCH-USD', unit: 1 },
}

export interface CftcExtraRow {
  date: string
  venue: 'cme' | 'cde'
  oiUsd: number
}

/** Weekly USD OI for the non-major CFTC-reported contracts since fromDate. */
export async function cftcExtraOi(fromDate: string): Promise<CftcExtraRow[]> {
  const names = Object.keys(CFTC_EXTRA)
    .map((n) => `'${n.replace(/'/g, "''")}'`)
    .join(',')
  const where = encodeURIComponent(
    `report_date_as_yyyy_mm_dd >= '${fromDate}' AND market_and_exchange_names in(${names})`
  )
  const records = await fetchJson<
    { report_date_as_yyyy_mm_dd: string; market_and_exchange_names: string; open_interest_all: string }[]
  >(
    `https://publicreporting.cftc.gov/resource/6dca-aqww.json?$limit=50000&$where=${where}&$select=report_date_as_yyyy_mm_dd,market_and_exchange_names,open_interest_all`
  )

  const spots = new Map<string, Map<string, number>>()
  for (const symbol of new Set(Object.values(CFTC_EXTRA).map((s) => s.spot))) {
    spots.set(symbol, await spotCloseHistorySymbol(symbol, fromDate))
  }

  const rows: CftcExtraRow[] = []
  for (const rec of records) {
    const spec = CFTC_EXTRA[rec.market_and_exchange_names]
    if (!spec) continue
    const date = rec.report_date_as_yyyy_mm_dd.slice(0, 10)
    const contracts = parseFloat(rec.open_interest_all)
    if (!Number.isFinite(contracts)) continue
    const closes = spots.get(spec.spot)!
    let close = closes.get(date) ?? null
    if (close == null) {
      const d = new Date(`${date}T00:00:00Z`)
      for (let i = 0; i < 7 && close == null; i++) {
        d.setUTCDate(d.getUTCDate() - 1)
        close = closes.get(d.toISOString().slice(0, 10)) ?? null
      }
    }
    if (close == null) continue
    rows.push({ date, venue: spec.venue, oiUsd: contracts * spec.unit * close })
  }
  return rows
}
