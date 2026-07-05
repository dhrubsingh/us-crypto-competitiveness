// One-shot (idempotent) historical backfill, 12 months where sources allow:
//   volume  — Binance Vision archives, Bybit/OKX/Deribit/Hyperliquid REST
//             history, CME via Yahoo (1y), Kalshi candlesticks (from launch)
//   funding — venue funding-history endpoints / archives
//   OI      — OKX rubik (asset-wide), Bybit history, Binance (~30d retained),
//             CFTC COT weekly for CME + Coinbase Derivatives (full year+)
// Sources with no public history (Deribit/Hyperliquid OI, CDE volume) simply
// accumulate forward from daily ingests.
//
// Usage: npm run backfill [-- --from 2025-07-01] [--only binance,okx]

import { ASSETS, Asset, VolumeRow, OiRow, FundingRow } from '../src/lib/observatory/types'
import { DailyPoint } from '../src/lib/observatory/sources/common'
import * as binance from '../src/lib/observatory/sources/binance'
import * as bybit from '../src/lib/observatory/sources/bybit'
import * as okx from '../src/lib/observatory/sources/okx'
import * as deribit from '../src/lib/observatory/sources/deribit'
import * as hyperliquid from '../src/lib/observatory/sources/hyperliquid'
import * as kraken from '../src/lib/observatory/sources/kraken'
import * as cde from '../src/lib/observatory/sources/cde'
import * as cme from '../src/lib/observatory/sources/cme'
import * as kalshi from '../src/lib/observatory/sources/kalshi'
import * as krakenus from '../src/lib/observatory/sources/krakenus'
import { cftcOiHistory } from '../src/lib/observatory/sources/cftc'
import { TOTAL_HISTORY_VENUES } from '../src/lib/observatory/sources/totalsHistory'
import { spotCloseHistory } from '../src/lib/observatory/sources/spot'
import { TotalRow } from '../src/lib/observatory/types'
import { readRows, upsertRows } from './store'

const args = process.argv.slice(2)
function argValue(flag: string): string | null {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : null
}

const FROM =
  argValue('--from') ?? new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10)
const ONLY = argValue('--only')?.split(',') ?? null

const key = (r: { date: string; venue: string; asset: string }) => `${r.date}|${r.venue}|${r.asset}`

function toRows<T extends { date: string }>(
  points: DailyPoint[],
  venue: string,
  asset: Asset,
  field: 'volumeUsd' | 'oiUsd' | 'rate8hPct',
  source: string
): T[] {
  const today = new Date().toISOString().slice(0, 10)
  return points
    .filter((p) => Number.isFinite(p.value) && p.date < today) // today comes from ingest, not backfill
    .map((p) => ({ date: p.date, venue, asset, [field]: p.value, source }) as unknown as T)
}

async function run(name: string, fn: () => Promise<void>) {
  if (ONLY && !ONLY.includes(name)) return
  try {
    console.log(`— ${name}`)
    await fn()
  } catch (err) {
    console.error(`[${name}] FAILED: ${err instanceof Error ? err.message : err}`)
  }
}

async function main() {
  console.log(`backfilling from ${FROM}`)

  await run('binance', async () => {
    for (const asset of ASSETS) {
      const vol = await binance.binanceVolumeHistory(asset, FROM)
      const fund = await binance.binanceFundingHistory(asset, FROM)
      console.log(`  ${asset}: ${vol.length} volume days, ${fund.length} funding days`)
      upsertRows<VolumeRow>('volume_daily.json', toRows(vol, 'binance', asset, 'volumeUsd', 'binance-vision'), key)
      upsertRows<FundingRow>('funding_daily.json', toRows(fund, 'binance', asset, 'rate8hPct', 'binance-vision'), key)
      try {
        const oi = await binance.binanceOiHistory(asset)
        upsertRows<OiRow>('oi_daily.json', toRows(oi, 'binance', asset, 'oiUsd', 'binance-fapi-30d'), key)
      } catch (err) {
        console.error(`  ${asset} OI: ${err}`)
      }
    }
  })

  await run('bybit', async () => {
    for (const asset of ASSETS) {
      const vol = await bybit.bybitVolumeHistory(asset, FROM)
      const oi = await bybit.bybitOiHistory(asset, FROM)
      const fund = await bybit.bybitFundingHistory(asset, FROM)
      console.log(`  ${asset}: ${vol.length} vol, ${oi.length} oi, ${fund.length} funding days`)
      upsertRows<VolumeRow>('volume_daily.json', toRows(vol, 'bybit', asset, 'volumeUsd', 'bybit-v5'), key)
      upsertRows<OiRow>('oi_daily.json', toRows(oi, 'bybit', asset, 'oiUsd', 'bybit-v5'), key)
      upsertRows<FundingRow>('funding_daily.json', toRows(fund, 'bybit', asset, 'rate8hPct', 'bybit-v5'), key)
    }
  })

  await run('okx', async () => {
    for (const asset of ASSETS) {
      const vol = await okx.okxVolumeHistory(asset, FROM)
      const oi = await okx.okxOiHistory(asset, FROM)
      const fund = await okx.okxFundingHistory(asset, FROM)
      console.log(`  ${asset}: ${vol.length} vol, ${oi.length} oi, ${fund.length} funding days`)
      upsertRows<VolumeRow>('volume_daily.json', toRows(vol, 'okx', asset, 'volumeUsd', 'okx-v5'), key)
      upsertRows<OiRow>('oi_daily.json', toRows(oi, 'okx', asset, 'oiUsd', 'okx-rubik'), key)
      upsertRows<FundingRow>('funding_daily.json', toRows(fund, 'okx', asset, 'rate8hPct', 'okx-v5'), key)
    }
  })

  await run('deribit', async () => {
    for (const asset of ASSETS) {
      const vol = await deribit.deribitVolumeHistory(asset, FROM)
      const fund = await deribit.deribitFundingHistory(asset, FROM)
      console.log(`  ${asset}: ${vol.length} vol days (perp only), ${fund.length} funding days`)
      upsertRows<VolumeRow>('volume_daily.json', toRows(vol, 'deribit', asset, 'volumeUsd', 'deribit-perp-chart'), key)
      upsertRows<FundingRow>('funding_daily.json', toRows(fund, 'deribit', asset, 'rate8hPct', 'deribit-api'), key)
    }
  })

  await run('hyperliquid', async () => {
    for (const asset of ASSETS) {
      const vol = await hyperliquid.hyperliquidVolumeHistory(asset, FROM)
      const fund = await hyperliquid.hyperliquidFundingHistory(asset, FROM)
      console.log(`  ${asset}: ${vol.length} vol days, ${fund.length} funding days`)
      upsertRows<VolumeRow>('volume_daily.json', toRows(vol, 'hyperliquid', asset, 'volumeUsd', 'hyperliquid-candles'), key)
      upsertRows<FundingRow>('funding_daily.json', toRows(fund, 'hyperliquid', asset, 'rate8hPct', 'hyperliquid-api'), key)
    }
  })

  await run('kraken', async () => {
    for (const asset of ASSETS) {
      const vol = await kraken.krakenVolumeHistory(asset, FROM)
      const fund = await kraken.krakenFundingHistory(asset, FROM)
      console.log(`  ${asset}: ${vol.length} vol days (PF perp), ${fund.length} funding days`)
      upsertRows<VolumeRow>('volume_daily.json', toRows(vol, 'kraken', asset, 'volumeUsd', 'kraken-charts'), key)
      upsertRows<FundingRow>('funding_daily.json', toRows(fund, 'kraken', asset, 'rate8hPct', 'kraken-v4'), key)
    }
  })

  await run('kraken_us', async () => {
    for (const asset of ASSETS) {
      const fund = await krakenus.krakenUsFundingHistory(asset, FROM)
      console.log(`  ${asset}: ${fund.length} funding days (since 2026 launch)`)
      upsertRows<FundingRow>('funding_daily.json', toRows(fund, 'kraken_us', asset, 'rate8hPct', 'bitnomial-api'), key)
    }
  })

  await run('cde', async () => {
    for (const asset of ASSETS) {
      const vol = await cde.cdeVolumeHistory(asset, FROM)
      console.log(`  ${asset}: ${vol.length} vol days (currently-listed contracts)`)
      upsertRows<VolumeRow>('volume_daily.json', toRows(vol, 'cde', asset, 'volumeUsd', 'coinbase-candles'), key)
    }
  })

  await run('cde-funding', async () => {
    // Reconstruction never overwrites funding actually observed at ingest
    const existing = new Set(
      readRows<FundingRow>('funding_daily.json')
        .filter((r) => r.venue === 'cde' && r.source !== 'premium-reconstruction')
        .map((r) => `${r.date}|${r.asset}`)
    )
    for (const asset of ASSETS) {
      const est = await cde.cdeFundingHistoryEstimate(asset, FROM)
      const fresh = est.filter((p) => !existing.has(`${p.date}|${asset}`))
      console.log(`  ${asset}: ${est.length} estimated days (${fresh.length} new)`)
      upsertRows<FundingRow>(
        'funding_daily.json',
        toRows(fresh, 'cde', asset, 'rate8hPct', 'premium-reconstruction'),
        key
      )
    }
  })

  await run('cme', async () => {
    for (const asset of ASSETS) {
      const vol = await cme.cmeVolumeHistory(asset, FROM)
      console.log(`  ${asset}: ${vol.length} vol days`)
      upsertRows<VolumeRow>('volume_daily.json', toRows(vol, 'cme', asset, 'volumeUsd', 'yahoo-front-month'), key)
    }
  })

  await run('kalshi', async () => {
    for (const asset of ASSETS) {
      const vol = await kalshi.kalshiVolumeHistory(asset, FROM)
      const oi = await kalshi.kalshiOiHistory(asset, FROM)
      const fund = await kalshi.kalshiFundingHistory(asset, FROM)
      console.log(`  ${asset}: ${vol.length} vol days, ${oi.length} oi days, ${fund.length} funding days`)
      upsertRows<VolumeRow>('volume_daily.json', toRows(vol, 'kalshi', asset, 'volumeUsd', 'kalshi-candles'), key)
      upsertRows<OiRow>('oi_daily.json', toRows(oi, 'kalshi', asset, 'oiUsd', 'kalshi-candles'), key)
      upsertRows<FundingRow>('funding_daily.json', toRows(fund, 'kalshi', asset, 'rate8hPct', 'kalshi-api'), key)
    }
  })

  await run('cme-basis', async () => {
    // Annualized front-month basis vs spot. Front-month expiry approximated as
    // the last Friday of the observation month, rolling to the next month
    // inside 10 days of expiry — annualizing over a near-zero window otherwise
    // blows small close-timing mismatches up into ±100%+ readings.
    const lastFriday = (y: number, m: number) => {
      const d = new Date(Date.UTC(y, m + 1, 0))
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 2) % 7))
      return d
    }
    for (const asset of ASSETS) {
      const [futClose, spotClose] = await Promise.all([
        cme.cmeCloseHistory(asset, FROM),
        spotCloseHistory(asset, FROM),
      ])
      const rows = []
      for (const [date, fut] of futClose) {
        const spot = spotClose.get(date)
        if (!spot) continue
        const obs = new Date(`${date}T00:00:00Z`)
        let exp = lastFriday(obs.getUTCFullYear(), obs.getUTCMonth())
        if (exp.getTime() - obs.getTime() < 10 * 86_400_000) {
          exp = lastFriday(obs.getUTCFullYear(), obs.getUTCMonth() + 1)
        }
        const dte = (exp.getTime() - obs.getTime()) / 86_400_000
        rows.push({
          date,
          venue: 'cme' as const,
          asset,
          instrument: 'front-month',
          markPrice: fut,
          spotPrice: spot,
          basisAnnualizedPct: ((fut - spot) / spot) * (365 / dte) * 100,
          kind: 'future' as const,
        })
      }
      console.log(`  ${asset}: ${rows.length} basis days`)
      upsertRows('basis_daily.json', rows, key)
    }
  })

  await run('cftc', async () => {
    const closes = {
      BTC: await spotCloseHistory('BTC', FROM),
      ETH: await spotCloseHistory('ETH', FROM),
      SOL: await spotCloseHistory('SOL', FROM),
    }
    const rows = await cftcOiHistory(FROM, closes)
    console.log(`  ${rows.length} weekly OI rows`)
    upsertRows('cftc_oi_weekly.json', rows, (r) => `${r.date}|${r.contractName}`)
  })

  // Venue-wide "everything listed" volume history — a per-contract sweep over
  // every venue's current catalog (thousands of candle requests; ~20–30 min).
  await run('totals-volume', async () => {
    for (const { venue, fn } of TOTAL_HISTORY_VENUES) {
      try {
        const points = await fn(FROM)
        console.log(`  ${venue}: ${points.length} days`)
        upsertRows<TotalRow>(
          'volume_total_daily.json',
          points.map((p) => ({ date: p.date, venue, valueUsd: p.value, source: 'candle-reconstruction' })),
          (r) => `${r.date}|${r.venue}`
        )
      } catch (err) {
        console.error(`  ${venue} FAILED: ${err instanceof Error ? err.message : err}`)
      }
    }
  })

  console.log('backfill complete')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
