import { fetchJson } from '../fetch'
import { VenueId } from '../types'

// The listing gap: programmatically enumerate every derivative contract on
// every tracked venue, normalize each to its underlying, and record which
// underlyings trade offshore with no US-regulated listing (and vice versa).
// Classification is a documented heuristic: curated symbol sets for FX and
// tokenized-equity ("xStock") products, CDE's CDE-prefixed roots as RWA
// commodities/indices, everything else crypto.

export type ListingCategory = 'crypto' | 'equity' | 'preipo' | 'commodity' | 'index' | 'fx'

export interface ListingRow {
  underlying: string
  category: ListingCategory
  offshoreVenues: string[]
  onshoreVenues: string[]
  offshoreVolumeUsd: number
  onshoreVolumeUsd: number
}

export interface ListingGap {
  generatedAt: string
  rows: ListingRow[]
}

// Kraken's tokenized-equity ("xStock") perps — X-suffixed equity tickers not
// listed on Binance, so outside its classification metadata.
const XSTOCKS = new Set([
  'SPYX', 'QQQX', 'TSLAX', 'NVDAX', 'AAPLX', 'MSTRX', 'COINX', 'HOODX', 'METAX',
  'AMZNX', 'GOOGLX', 'MSFTX', 'CRCLX', 'PLTRX', 'NFLXX', 'AMDX', 'INTCX', 'GMEX',
  'IBITX', 'BRKBX', 'AVGOX', 'LLYX', 'JPMX', 'UNHX', 'ORCLX', 'DJTX',
])

const FX = new Set(['EUR', 'GBP', 'JPY', 'AUD', 'CHF', 'CAD'])

const CDE_COMMODITY = new Set(['CDEGLD', 'CDESIL', 'CDEOIL', 'CDECU', 'CDENGS', 'CDEPT'])

/**
 * Classification is programmatic where a venue publishes it: Binance's
 * exchangeInfo tags every listing with an underlyingType (COIN, EQUITY,
 * KR_EQUITY, PREMARKET, COMMODITY, INDEX), which covers most cross-listed
 * symbols. Curated fallbacks handle what Binance doesn't list: Kraken xStocks,
 * FX pairs, and CDE's commodity/sector-index roots.
 */
function classify(sym: string, binanceType: Map<string, string>): ListingCategory {
  const bt = binanceType.get(sym)
  if (bt === 'PREMARKET') return 'preipo'
  if (bt === 'EQUITY' || bt === 'KR_EQUITY') return 'equity'
  if (bt === 'COMMODITY') return 'commodity'
  if (bt === 'INDEX') return 'index'
  if (bt === 'COIN') return 'crypto'
  if (FX.has(sym)) return 'fx'
  if (XSTOCKS.has(sym)) return 'equity'
  if (CDE_COMMODITY.has(sym)) return 'commodity'
  if (sym.startsWith('CDE')) return 'index'
  return 'crypto'
}

// Kilo-denominated meme tickers written in caps (e.g. Kalshi's KXKSHIBPERP).
// Can't strip a leading capital K generically — KAVA, KAS, KDA are real bases.
const KILO_ALIASES: Record<string, string> = {
  KSHIB: 'SHIB',
  KPEPE: 'PEPE',
  KBONK: 'BONK',
  KFLOKI: 'FLOKI',
  KLUNC: 'LUNC',
  KDOGS: 'DOGS',
}

/** Normalize venue base symbols to one underlying: 1000PEPE/kPEPE→PEPE, XBT→BTC… */
function normalizeBase(raw: string): string {
  let s = raw
  if (s.startsWith('k') && s.length > 3) s = s.slice(1) // Hyperliquid kPEPE/kSHIB/kBONK
  s = s.toUpperCase()
  if (s.startsWith('1000000')) s = s.slice(7)
  else if (s.startsWith('1000')) s = s.slice(4)
  if (s.endsWith('1000')) s = s.slice(0, -4)
  if (KILO_ALIASES[s]) s = KILO_ALIASES[s]
  if (s === 'XBT') s = 'BTC'
  return s
}

type VenueListing = Map<string, number> // underlying → 24h USD volume

function add(map: VenueListing, base: string, vol: number) {
  const sym = normalizeBase(base)
  if (!sym || sym.length > 12) return
  map.set(sym, (map.get(sym) ?? 0) + (Number.isFinite(vol) ? vol : 0))
}

async function binanceListings(): Promise<{ listing: VenueListing; types: Map<string, string> }> {
  const [info, tickers] = await Promise.all([
    fetchJson<{
      symbols: { symbol: string; baseAsset: string; status: string; underlyingType?: string }[]
    }>('https://fapi.binance.com/fapi/v1/exchangeInfo'),
    fetchJson<{ symbol: string; quoteVolume: string }[]>('https://fapi.binance.com/fapi/v1/ticker/24hr'),
  ])
  const volBySymbol = new Map(tickers.map((t) => [t.symbol, parseFloat(t.quoteVolume) || 0]))
  const listing: VenueListing = new Map()
  const types = new Map<string, string>()
  for (const s of info.symbols) {
    if (s.status !== 'TRADING') continue
    add(listing, s.baseAsset, volBySymbol.get(s.symbol) ?? 0)
    if (s.underlyingType) types.set(normalizeBase(s.baseAsset), s.underlyingType)
  }
  return { listing, types }
}

async function bybitListings(): Promise<VenueListing> {
  const out: VenueListing = new Map()
  for (const category of ['linear', 'inverse']) {
    const res = await fetchJson<{ result: { list: { symbol: string; turnover24h: string }[] } }>(
      `https://api.bybit.com/v5/market/tickers?category=${category}`
    )
    for (const t of res.result.list) {
      const base = t.symbol.replace(/(USDT|USDC|PERP|USD)$/i, '').replace(/-\d{2}[A-Z]{3}\d{2}$/, '')
      add(out, base, parseFloat(t.turnover24h) || 0)
    }
  }
  return out
}

async function okxListings(): Promise<VenueListing> {
  const out: VenueListing = new Map()
  for (const instType of ['SWAP', 'FUTURES']) {
    const res = await fetchJson<{ data: { instId: string; last: string; volCcy24h: string }[] }>(
      `https://www.okx.com/api/v5/market/tickers?instType=${instType}`
    )
    for (const t of res.data) {
      add(out, t.instId.split('-')[0], (parseFloat(t.volCcy24h) || 0) * (parseFloat(t.last) || 0))
    }
  }
  return out
}

async function deribitListings(): Promise<VenueListing> {
  const out: VenueListing = new Map()
  for (const currency of ['BTC', 'ETH', 'USDC', 'USDT']) {
    const res = await fetchJson<{ result: { instrument_name: string; volume_usd?: number }[] }>(
      `https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${currency}&kind=future`
    )
    for (const s of res.result) {
      // BTC-PERPETUAL / SOL_USDC-PERPETUAL / PAXG_USDC-…
      const base = s.instrument_name.split(/[-_]/)[0]
      add(out, base, s.volume_usd ?? 0)
    }
  }
  return out
}

async function hyperliquidListings(): Promise<VenueListing> {
  const res = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`hyperliquid HTTP ${res.status}`)
  const [meta, ctxs] = (await res.json()) as [
    { universe: { name: string; isDelisted?: boolean }[] },
    { dayNtlVlm: string }[],
  ]
  const out: VenueListing = new Map()
  meta.universe.forEach((u, i) => {
    if (u.isDelisted) return
    add(out, u.name, parseFloat(ctxs[i]?.dayNtlVlm ?? '0') || 0)
  })
  return out
}

async function krakenListings(): Promise<VenueListing> {
  const { tickers } = await fetchJson<{ tickers: { symbol: string; volumeQuote?: number }[] }>(
    'https://futures.kraken.com/derivatives/api/v3/tickers'
  )
  const out: VenueListing = new Map()
  for (const t of tickers) {
    const m = t.symbol.toUpperCase().match(/^(?:PF|PI|FF|FI)_([A-Z0-9]+?)USD(?:T|C)?(?:_\d+)?$/)
    if (!m) continue
    add(out, m[1], t.volumeQuote ?? 0)
  }
  return out
}

async function cdeListings(): Promise<VenueListing> {
  const { products } = await fetchJson<{
    products: {
      price: string
      volume_24h: string
      is_disabled: boolean
      future_product_details?: { venue?: string; contract_root_unit?: string; contract_size?: string }
    }[]
  }>('https://api.coinbase.com/api/v3/brokerage/market/products?product_type=FUTURE&limit=250')
  const out: VenueListing = new Map()
  for (const p of products) {
    const f = p.future_product_details
    if (f?.venue !== 'cde' || p.is_disabled || !f.contract_root_unit) continue
    const vol = (parseFloat(p.volume_24h) || 0) * (parseFloat(f.contract_size ?? '') || 0) * (parseFloat(p.price) || 0)
    add(out, f.contract_root_unit, vol)
  }
  return out
}

async function kalshiListings(): Promise<VenueListing> {
  const { markets } = await fetchJson<{
    markets: { ticker: string; status: string; volume_24h_notional_value_dollars: string }[]
  }>('https://external-api.kalshi.com/trade-api/v2/margin/markets')
  const out: VenueListing = new Map()
  for (const m of markets) {
    if (m.status !== 'active') continue
    const match = m.ticker.match(/^KX([A-Z0-9]+?)PERP\d*$/)
    if (!match) continue
    add(out, match[1], parseFloat(m.volume_24h_notional_value_dollars) || 0)
  }
  return out
}

const BITNOMIAL_NAMES: Record<string, string> = {
  'Bitcoin Cash': 'BCH',
  Bitcoin: 'BTC',
  Ethereum: 'ETH',
  Solana: 'SOL',
  Dogecoin: 'DOGE',
  Litecoin: 'LTC',
  'Shiba Inu': 'SHIB',
  Tezos: 'XTZ',
  Polkadot: 'DOT',
  XRP: 'XRP',
  Chainlink: 'LINK',
  Avalanche: 'AVAX',
  Sui: 'SUI',
  Cardano: 'ADA',
  Hedera: 'HBAR',
  Stellar: 'XLM',
  Near: 'NEAR',
  Uniswap: 'UNI',
  Aave: 'AAVE',
  Zcash: 'ZEC',
  Pepe: 'PEPE',
  Bonk: 'BONK',
  Hyperliquid: 'HYPE',
}

async function krakenUsListings(): Promise<VenueListing> {
  const [specs, data] = await Promise.all([
    fetchJson<{ product_id: number; product_name: string; product_status: string; type?: string }[]>(
      'https://bitnomial.com/exchange/api/v1/prod/product/specs/'
    ),
    fetchJson<{ product_id: number; notional_volume: number | null }[]>(
      'https://bitnomial.com/exchange/api/v1/prod/product/data/'
    ),
  ])
  const volById = new Map(data.map((d) => [d.product_id, d.notional_volume ?? 0]))
  const out: VenueListing = new Map()
  for (const s of specs) {
    if (s.product_status !== 'active' || s.type !== 'perpetual') continue
    const m = s.product_name.match(/^Perpetual (.+?) US Dollar/)
    if (!m) continue
    const sym = BITNOMIAL_NAMES[m[1]]
    if (!sym) continue
    add(out, sym, volById.get(s.product_id) ?? 0)
  }
  return out
}

// CME's crypto underlyings (curated; CME has no free instruments API)
async function cmeListings(): Promise<VenueListing> {
  return new Map(['BTC', 'ETH', 'SOL', 'XRP'].map((s) => [s, 0]))
}

export async function buildListingGap(): Promise<ListingGap> {
  // Binance goes first — its exchangeInfo supplies the classification metadata
  let binanceData: { listing: VenueListing; types: Map<string, string> } | null = null
  try {
    binanceData = await binanceListings()
  } catch (err) {
    console.error(`[listings] Binance: ${err instanceof Error ? err.message : err}`)
  }
  const binanceTypes = binanceData?.types ?? new Map<string, string>()

  const venues: { venue: VenueId; name: string; region: 'onshore' | 'offshore'; fn: () => Promise<VenueListing> }[] = [
    { venue: 'binance', name: 'Binance', region: 'offshore', fn: async () => binanceData?.listing ?? new Map() },
    { venue: 'bybit', name: 'Bybit', region: 'offshore', fn: bybitListings },
    { venue: 'okx', name: 'OKX', region: 'offshore', fn: okxListings },
    { venue: 'deribit', name: 'Deribit', region: 'offshore', fn: deribitListings },
    { venue: 'hyperliquid', name: 'Hyperliquid', region: 'offshore', fn: hyperliquidListings },
    { venue: 'kraken', name: 'Kraken Futures', region: 'offshore', fn: krakenListings },
    { venue: 'cme', name: 'CME', region: 'onshore', fn: cmeListings },
    { venue: 'cde', name: 'Coinbase Derivatives', region: 'onshore', fn: cdeListings },
    { venue: 'kalshi', name: 'Kalshi', region: 'onshore', fn: kalshiListings },
    { venue: 'kraken_us', name: 'Kraken US', region: 'onshore', fn: krakenUsListings },
  ]

  const byUnderlying = new Map<string, ListingRow>()
  for (const v of venues) {
    let listing: VenueListing
    try {
      listing = await v.fn()
    } catch (err) {
      console.error(`[listings] ${v.name}: ${err instanceof Error ? err.message : err}`)
      continue
    }
    for (const [sym, vol] of listing) {
      let row = byUnderlying.get(sym)
      if (!row) {
        row = {
          underlying: sym,
          category: classify(sym, binanceTypes),
          offshoreVenues: [],
          onshoreVenues: [],
          offshoreVolumeUsd: 0,
          onshoreVolumeUsd: 0,
        }
        byUnderlying.set(sym, row)
      }
      if (v.region === 'offshore') {
        row.offshoreVenues.push(v.name)
        row.offshoreVolumeUsd += vol
      } else {
        row.onshoreVenues.push(v.name)
        row.onshoreVolumeUsd += vol
      }
    }
  }

  const rows = [...byUnderlying.values()].sort((a, b) => b.offshoreVolumeUsd - a.offshoreVolumeUsd)
  return { generatedAt: new Date().toISOString(), rows }
}
