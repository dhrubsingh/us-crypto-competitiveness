import { fetchJson } from '../fetch'
import { Asset, CftcOiRow } from '../types'

// CFTC Commitments of Traders via the Commission's public Socrata API
// (publicreporting.cftc.gov, dataset 6dca-aqww — Traders in Financial
// Futures, futures only). Weekly Tuesday snapshots of open interest for every
// CFTC-regulated crypto contract. This is the authoritative public OI source
// for CME and Coinbase Derivatives, with history back to each listing date.

const SODA = 'https://publicreporting.cftc.gov/resource/6dca-aqww.json'

interface CotRecord {
  report_date_as_yyyy_mm_dd: string
  market_and_exchange_names: string
  open_interest_all: string
}

interface ContractSpec {
  venue: 'cme' | 'cde'
  asset: Asset
  unit: number // asset units per contract
}

// market_and_exchange_names → contract spec. Contract units from CME specs
// and the Coinbase Derivatives product catalog (contract_size field).
const CONTRACT_MAP: Record<string, ContractSpec> = {
  'BITCOIN - CHICAGO MERCANTILE EXCHANGE': { venue: 'cme', asset: 'BTC', unit: 5 },
  'MICRO BITCOIN - CHICAGO MERCANTILE EXCHANGE': { venue: 'cme', asset: 'BTC', unit: 0.1 },
  'ETHER CASH SETTLED - CHICAGO MERCANTILE EXCHANGE': { venue: 'cme', asset: 'ETH', unit: 50 },
  'MICRO ETHER - CHICAGO MERCANTILE EXCHANGE': { venue: 'cme', asset: 'ETH', unit: 0.1 },
  'SOL - CHICAGO MERCANTILE EXCHANGE': { venue: 'cme', asset: 'SOL', unit: 500 },
  'MICRO SOL - CHICAGO MERCANTILE EXCHANGE': { venue: 'cme', asset: 'SOL', unit: 25 },
  // LMX Labs, LLC is Coinbase Derivatives' former legal name (FairX); older
  // report weeks carry it, so both names map to the same venue.
  'Nano Bitcoin - LMX LABS LLC': { venue: 'cde', asset: 'BTC', unit: 0.01 },
  'NANO ETHER - LMX LABS LLC': { venue: 'cde', asset: 'ETH', unit: 0.1 },
  'NANO SOLANA - LMX LABS LLC': { venue: 'cde', asset: 'SOL', unit: 5 },
  'Nano Bitcoin - COINBASE DERIVATIVES, LLC': { venue: 'cde', asset: 'BTC', unit: 0.01 },
  'NANO BITCOIN PERP STYLE - COINBASE DERIVATIVES, LLC': { venue: 'cde', asset: 'BTC', unit: 0.01 },
  'NANO ETHER - COINBASE DERIVATIVES, LLC': { venue: 'cde', asset: 'ETH', unit: 0.1 },
  'NANO ETHER PERP STYLE - COINBASE DERIVATIVES, LLC': { venue: 'cde', asset: 'ETH', unit: 0.1 },
  'NANO SOLANA - COINBASE DERIVATIVES, LLC': { venue: 'cde', asset: 'SOL', unit: 5 },
  'NANO SOLANA PERP STYLE - COINBASE DERIVATIVES, LLC': { venue: 'cde', asset: 'SOL', unit: 5 },
}

/**
 * Weekly OI rows for all mapped contracts since `fromDate`.
 * `spotCloses` (asset → date → close) dollarizes contract counts; the nearest
 * close at-or-before the report date is used.
 */
export async function cftcOiHistory(
  fromDate: string,
  spotCloses: Record<Asset, Map<string, number>>
): Promise<CftcOiRow[]> {
  const names = Object.keys(CONTRACT_MAP)
    .map((n) => `'${n.replace(/'/g, "''")}'`)
    .join(',')
  const where = encodeURIComponent(
    `report_date_as_yyyy_mm_dd >= '${fromDate}' AND market_and_exchange_names in(${names})`
  )
  const records = await fetchJson<CotRecord[]>(
    `${SODA}?$limit=50000&$where=${where}&$select=report_date_as_yyyy_mm_dd,market_and_exchange_names,open_interest_all`
  )

  const rows: CftcOiRow[] = []
  for (const rec of records) {
    const spec = CONTRACT_MAP[rec.market_and_exchange_names]
    if (!spec) continue
    const date = rec.report_date_as_yyyy_mm_dd.slice(0, 10)
    const contracts = parseFloat(rec.open_interest_all)
    if (!Number.isFinite(contracts)) continue
    const close = nearestCloseAtOrBefore(spotCloses[spec.asset], date)
    if (close == null) continue
    rows.push({
      date,
      venue: spec.venue,
      asset: spec.asset,
      contractName: rec.market_and_exchange_names,
      oiContracts: contracts,
      contractUnit: spec.unit,
      oiUsd: contracts * spec.unit * close,
    })
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

function nearestCloseAtOrBefore(closes: Map<string, number>, date: string): number | null {
  if (closes.has(date)) return closes.get(date)!
  // walk back up to a week (reports are Tuesdays; markets trade daily, so this rarely goes past 1)
  const d = new Date(`${date}T00:00:00Z`)
  for (let i = 0; i < 7; i++) {
    d.setUTCDate(d.getUTCDate() - 1)
    const key = d.toISOString().slice(0, 10)
    if (closes.has(key)) return closes.get(key)!
  }
  return null
}
