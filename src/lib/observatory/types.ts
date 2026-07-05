// Canonical row shapes for the observatory dataset. Everything the pipeline
// writes and the site reads flows through these types.

export type Asset = 'BTC' | 'ETH' | 'SOL'
export const ASSETS: Asset[] = ['BTC', 'ETH', 'SOL']

export type Region = 'onshore' | 'offshore'

export type VenueId =
  | 'binance'
  | 'bybit'
  | 'okx'
  | 'deribit'
  | 'hyperliquid'
  | 'kraken'
  | 'cme'
  | 'cde'
  | 'kalshi'
  | 'kraken_us'

export interface VenueInfo {
  id: VenueId
  name: string
  region: Region
  regulator: string
  // Which method each metric comes from, shown on the methodology page
  volumeSource: string
  oiSource: string
}

export const VENUES: Record<VenueId, VenueInfo> = {
  binance: {
    id: 'binance',
    name: 'Binance',
    region: 'offshore',
    regulator: 'Unregulated (US-blocked)',
    volumeSource: 'Binance Futures API (USDT-margined perps), fetched via EU relay',
    oiSource: 'Binance Futures API openInterest × mark price',
  },
  bybit: {
    id: 'bybit',
    name: 'Bybit',
    region: 'offshore',
    regulator: 'Unregulated (US-blocked)',
    volumeSource: 'Bybit v5 API 24h turnover (linear perps), fetched via EU relay',
    oiSource: 'Bybit v5 API openInterestValue',
  },
  okx: {
    id: 'okx',
    name: 'OKX',
    region: 'offshore',
    regulator: 'Unregulated (US-blocked)',
    volumeSource: 'OKX v5 API 24h volume (USDT swaps)',
    oiSource: 'OKX v5 API open interest (USD)',
  },
  deribit: {
    id: 'deribit',
    name: 'Deribit',
    region: 'offshore',
    regulator: 'Dubai VARA',
    volumeSource: 'Deribit public API, 24h USD volume summed across futures + perps',
    oiSource: 'Deribit public API open interest',
  },
  hyperliquid: {
    id: 'hyperliquid',
    name: 'Hyperliquid',
    region: 'offshore',
    regulator: 'Unregulated (onchain)',
    volumeSource: 'Hyperliquid info API daily notional volume',
    oiSource: 'Hyperliquid info API open interest × mark price',
  },
  kraken: {
    id: 'kraken',
    name: 'Kraken Futures (non-US)',
    region: 'offshore',
    regulator: 'Crypto Facilities — UK FCA, closed to US persons',
    volumeSource: 'Kraken Futures public API, 24h quote volume summed across listed contracts',
    oiSource: 'Kraken Futures public API open interest',
  },
  cme: {
    id: 'cme',
    name: 'CME',
    region: 'onshore',
    regulator: 'CFTC DCM',
    volumeSource: 'Front-month contract volume (Yahoo Finance delayed feed) × contract size × price',
    oiSource: 'CFTC Commitments of Traders, weekly, all expiries',
  },
  cde: {
    id: 'cde',
    name: 'Coinbase Derivatives',
    region: 'onshore',
    regulator: 'CFTC DCM',
    volumeSource: 'Coinbase public market API: 24h contract volume live, daily candles for history × contract size × price',
    oiSource: 'CFTC Commitments of Traders, weekly, all listed contracts',
  },
  kalshi: {
    id: 'kalshi',
    name: 'Kalshi',
    region: 'onshore',
    regulator: 'CFTC DCM',
    volumeSource: 'Kalshi perps public API 24h notional volume',
    oiSource: 'Kalshi perps public API open interest notional',
  },
  kraken_us: {
    id: 'kraken_us',
    name: 'Kraken US (Bitnomial)',
    region: 'onshore',
    regulator: 'CFTC DCM/DCO (Bitnomial Exchange)',
    volumeSource: 'Bitnomial public API daily notional volume, perpetual contracts',
    oiSource: 'Bitnomial public API open interest × contract size × spot',
  },
}

export const VENUE_IDS = Object.keys(VENUES) as VenueId[]
export const ONSHORE_VENUES = VENUE_IDS.filter((v) => VENUES[v].region === 'onshore')
export const OFFSHORE_VENUES = VENUE_IDS.filter((v) => VENUES[v].region === 'offshore')

// ---------------------------------------------------------------------------
// Timeseries rows (stored in public/data/*.json, one array per file)
// ---------------------------------------------------------------------------

/** Daily traded volume in USD notional. `date` is UTC YYYY-MM-DD. */
export interface VolumeRow {
  date: string
  venue: VenueId
  asset: Asset
  volumeUsd: number
  source: string
}

/** Daily open interest in USD notional (end-of-day or snapshot-at-ingest). */
export interface OiRow {
  date: string
  venue: VenueId
  asset: Asset
  oiUsd: number
  source: string
}

/** Daily funding, stored as the 8h-equivalent rate in percent. */
export interface FundingRow {
  date: string
  venue: VenueId
  asset: Asset
  rate8hPct: number
  source: string
}

/** Weekly CFTC Commitments of Traders open interest, in contracts and USD. */
export interface CftcOiRow {
  date: string // report date, YYYY-MM-DD (Tuesdays)
  venue: 'cme' | 'cde'
  asset: Asset
  contractName: string
  oiContracts: number
  contractUnit: number // asset units per contract
  oiUsd: number
}

/** Order-book snapshot metrics, taken at ingest time. */
export interface DepthRow {
  date: string
  timestamp: number
  venue: VenueId
  asset: Asset
  midPrice: number
  spreadBps: number
  /** Average one-way execution cost vs mid, in bps, for a market order of this notional. Null = book too thin to fill. */
  fillCost100kBps: number | null
  fillCost1mBps: number | null
  /** Total book depth in USD within ±50bps of mid. */
  depth50BpsUsd: number
}

/** Daily basis: perp/front-future mark vs spot index, annualized percent. */
export interface BasisRow {
  date: string
  venue: VenueId
  asset: Asset
  instrument: string
  markPrice: number
  spotPrice: number
  basisAnnualizedPct: number
  kind: 'perp' | 'future'
}

/** Venue-wide daily total (every listed contract, all assets). */
export interface TotalRow {
  date: string
  venue: VenueId
  valueUsd: number
  source: string
}

export interface RegulatoryEvent {
  date: string
  title: string
  description: string
  category: 'approval' | 'launch' | 'enforcement' | 'rulemaking'
  source: string // URL
}

export interface DatasetMeta {
  generatedAt: string
  lastIngestDate: string
  sources: Record<string, { lastSuccess: string | null; note?: string }>
}
