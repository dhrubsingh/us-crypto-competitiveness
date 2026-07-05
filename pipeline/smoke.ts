// Quick live check of every venue client — prints one line per venue × asset.
// Usage: npm run smoke [-- --asset BTC]

import { ASSETS, Asset, VenueId } from '../src/lib/observatory/types'
import { VenueSnapshot, fillCostBps } from '../src/lib/observatory/sources/common'
import { binanceSnapshot } from '../src/lib/observatory/sources/binance'
import { bybitSnapshot } from '../src/lib/observatory/sources/bybit'
import { okxSnapshot } from '../src/lib/observatory/sources/okx'
import { deribitSnapshot } from '../src/lib/observatory/sources/deribit'
import { hyperliquidSnapshot } from '../src/lib/observatory/sources/hyperliquid'
import { krakenSnapshot } from '../src/lib/observatory/sources/kraken'
import { cmeSnapshot } from '../src/lib/observatory/sources/cme'
import { cdeSnapshot } from '../src/lib/observatory/sources/cde'
import { kalshiSnapshot } from '../src/lib/observatory/sources/kalshi'
import { krakenUsSnapshot } from '../src/lib/observatory/sources/krakenus'

const fns: Record<VenueId, (a: Asset) => Promise<VenueSnapshot | null>> = {
  binance: binanceSnapshot,
  bybit: bybitSnapshot,
  okx: okxSnapshot,
  deribit: deribitSnapshot,
  hyperliquid: hyperliquidSnapshot,
  kraken: krakenSnapshot,
  cme: cmeSnapshot,
  cde: cdeSnapshot,
  kalshi: kalshiSnapshot,
  kraken_us: krakenUsSnapshot,
}

const fmt = (n: number | null, digits = 1) =>
  n == null ? '—' : n >= 1e9 ? `$${(n / 1e9).toFixed(digits)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(digits)}M` : `$${Math.round(n).toLocaleString()}`

async function main() {
  const onlyAsset = process.argv.includes('--asset')
    ? (process.argv[process.argv.indexOf('--asset') + 1] as Asset)
    : null
  for (const [venue, fn] of Object.entries(fns)) {
    for (const asset of ASSETS) {
      if (onlyAsset && asset !== onlyAsset) continue
      try {
        const s = await fn(asset)
        if (!s) {
          console.log(`${venue.padEnd(12)} ${asset}  (not listed)`)
          continue
        }
        const mid = s.book?.bids[0] && s.book?.asks[0] ? (s.book.bids[0][0] + s.book.asks[0][0]) / 2 : null
        const cost1m = s.book && mid ? fillCostBps(s.book.asks, mid, 1_000_000) : null
        console.log(
          `${venue.padEnd(12)} ${asset}  vol24h=${fmt(s.volumeUsd24h)}  oi=${fmt(s.oiUsd)}  ` +
            `funding8h=${s.rate8hPct == null ? '—' : s.rate8hPct.toFixed(4) + '%'}  mark=${s.markPrice?.toFixed(2) ?? '—'}  ` +
            `book=${s.book ? `${s.book.bids.length}×${s.book.asks.length} lvls, $1M cost=${cost1m == null ? 'thin' : cost1m.toFixed(2) + 'bps'}` : '—'}`
        )
      } catch (err) {
        console.log(`${venue.padEnd(12)} ${asset}  ERROR: ${err instanceof Error ? err.message : err}`)
      }
    }
  }
}

main()
