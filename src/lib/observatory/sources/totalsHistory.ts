import { fetchJson } from '../fetch'
import { VenueId } from '../types'
import { DailyPoint, toDailyDate } from './common'
import { cmeVolumeHistory } from './cme'

// Venue-wide volume history, reconstructed per contract: for every instrument
// in each venue's *current* catalog, pull daily candles for the past year and
// sum USD notional per day. Instruments delisted before today can't be
// enumerated, so older months undercount slightly — documented on the
// methodology page. OI history is not reconstructable this way (venues don't
// serve per-contract OI candles), so venue-wide OI accumulates from snapshots.

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0
  const workers = Array.from({ length: size }, async () => {
    while (i < items.length) {
      const item = items[i++]
      try {
        await fn(item)
      } catch {
        // per-instrument failures never sink the venue
      }
    }
  })
  await Promise.all(workers)
}

function accumulate(byDate: Map<string, number>, date: string, usd: number) {
  if (Number.isFinite(usd) && usd > 0) byDate.set(date, (byDate.get(date) ?? 0) + usd)
}

function toPoints(byDate: Map<string, number>, fromDate: string): DailyPoint[] {
  const today = new Date().toISOString().slice(0, 10)
  return [...byDate.entries()]
    .filter(([d]) => d >= fromDate && d < today) // today comes from the snapshot, not backfill
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

async function binanceHistory(fromDate: string): Promise<DailyPoint[]> {
  const info = await fetchJson<{ symbols: { symbol: string; status: string }[] }>(
    'https://fapi.binance.com/fapi/v1/exchangeInfo'
  )
  const symbols = info.symbols.filter((s) => s.status === 'TRADING').map((s) => s.symbol)
  const byDate = new Map<string, number>()
  await pool(symbols, 6, async (symbol) => {
    // kline row index 7 = quote (USD) volume
    const rows = await fetchJson<(string | number)[][]>(
      `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=400`
    )
    for (const r of rows) accumulate(byDate, toDailyDate(Number(r[0])), parseFloat(String(r[7])))
  })
  return toPoints(byDate, fromDate)
}

async function bybitHistory(fromDate: string): Promise<DailyPoint[]> {
  const byDate = new Map<string, number>()
  for (const category of ['linear', 'inverse']) {
    const res = await fetchJson<{ result: { list: { symbol: string }[] } }>(
      `https://api.bybit.com/v5/market/tickers?category=${category}`
    )
    const symbols = res.result.list.map((t) => t.symbol)
    await pool(symbols, 6, async (symbol) => {
      let end = Date.now()
      for (let page = 0; page < 2; page++) {
        const k = await fetchJson<{ result: { list: string[][] } }>(
          `https://api.bybit.com/v5/market/kline?category=${category}&symbol=${symbol}&interval=D&limit=200&end=${end}`
        )
        if (!k.result.list.length) break
        for (const row of k.result.list) {
          // linear turnover (idx 6) is USD; inverse turnover is in base coin → × close (idx 4)
          const usd = category === 'linear' ? parseFloat(row[6]) : parseFloat(row[6]) * parseFloat(row[4])
          accumulate(byDate, toDailyDate(parseInt(row[0], 10)), usd)
        }
        const oldest = parseInt(k.result.list[k.result.list.length - 1][0], 10)
        if (oldest >= end) break
        end = oldest - 1
      }
    })
  }
  return toPoints(byDate, fromDate)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function okxHistory(fromDate: string): Promise<DailyPoint[]> {
  const byDate = new Map<string, number>()
  for (const instType of ['SWAP', 'FUTURES']) {
    const tickers = await fetchJson<{ data: { instId: string }[] }>(
      `https://www.okx.com/api/v5/market/tickers?instType=${instType}`
    )
    const instIds = tickers.data.map((t) => t.instId)
    await pool(instIds, 3, async (instId) => {
      let after = ''
      for (let page = 0; page < 4; page++) {
        const rows = await fetchJson<{ data: string[][] }>(
          `https://www.okx.com/api/v5/market/history-candles?instId=${instId}&bar=1Dutc&limit=100${after ? `&after=${after}` : ''}`
        )
        if (!rows.data.length) break
        // index 7 = volCcyQuote (USD)
        for (const r of rows.data) accumulate(byDate, toDailyDate(parseInt(r[0], 10)), parseFloat(r[7]))
        after = rows.data[rows.data.length - 1][0]
        await sleep(120) // OKX rate limit: 20 req / 2s on this endpoint
      }
    })
  }
  return toPoints(byDate, fromDate)
}

async function krakenHistory(fromDate: string): Promise<DailyPoint[]> {
  const { tickers } = await fetchJson<{ tickers: { symbol: string }[] }>(
    'https://futures.kraken.com/derivatives/api/v3/tickers'
  )
  const symbols = tickers.map((t) => t.symbol).filter((s) => /^(PF|PI|FF|FI)_/i.test(s))
  const byDate = new Map<string, number>()
  const from = Math.floor(new Date(`${fromDate}T00:00:00Z`).getTime() / 1000)
  const to = Math.floor(Date.now() / 1000)
  await pool(symbols, 6, async (symbol) => {
    const { candles } = await fetchJson<{ candles: { time: number; close: string; volume: string }[] }>(
      `https://futures.kraken.com/api/charts/v1/trade/${symbol}/1d?from=${from}&to=${to}`
    )
    const inverse = /^(PI|FI)_/i.test(symbol) // $1 contracts: volume is already USD
    for (const c of candles ?? []) {
      const usd = inverse ? parseFloat(c.volume) : parseFloat(c.volume) * parseFloat(c.close)
      accumulate(byDate, toDailyDate(c.time), usd)
    }
  })
  return toPoints(byDate, fromDate)
}

async function hyperliquidHistory(fromDate: string): Promise<DailyPoint[]> {
  const meta = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'meta' }),
    signal: AbortSignal.timeout(20_000),
  }).then((r) => r.json() as Promise<{ universe: { name: string; isDelisted?: boolean }[] }>)
  const coins = meta.universe.filter((u) => !u.isDelisted).map((u) => u.name)
  const byDate = new Map<string, number>()
  const startTime = new Date(`${fromDate}T00:00:00Z`).getTime()
  await pool(coins, 4, async (coin) => {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval: '1d', startTime, endTime: Date.now() } }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return
    const candles = (await res.json()) as { t: number; c: string; v: string }[]
    for (const c of candles) accumulate(byDate, toDailyDate(c.t), parseFloat(c.v) * parseFloat(c.c))
  })
  return toPoints(byDate, fromDate)
}

async function deribitHistory(fromDate: string): Promise<DailyPoint[]> {
  const byDate = new Map<string, number>()
  const start = new Date(`${fromDate}T00:00:00Z`).getTime()
  const end = Date.now()
  for (const currency of ['BTC', 'ETH', 'USDC', 'USDT']) {
    const { result } = await fetchJson<{ result: { instrument_name: string }[] }>(
      `https://www.deribit.com/api/v2/public/get_instruments?currency=${currency}&kind=future&expired=false`
    )
    await pool(
      result.map((i) => i.instrument_name),
      5,
      async (name) => {
        const res = await fetchJson<{ result: { status: string; ticks: number[]; cost: number[] } }>(
          `https://www.deribit.com/api/v2/public/get_tradingview_chart_data?instrument_name=${name}&resolution=1D&start_timestamp=${start}&end_timestamp=${end}`
        )
        if (res.result.status !== 'ok') return
        res.result.ticks.forEach((t, i) => accumulate(byDate, toDailyDate(t), res.result.cost[i]))
      }
    )
  }
  return toPoints(byDate, fromDate)
}

async function cdeHistory(fromDate: string): Promise<DailyPoint[]> {
  const { products } = await fetchJson<{
    products: {
      product_id: string
      is_disabled: boolean
      future_product_details?: { venue?: string; contract_size?: string }
    }[]
  }>('https://api.coinbase.com/api/v3/brokerage/market/products?product_type=FUTURE&limit=250')
  const cde = products.filter((p) => p.future_product_details?.venue === 'cde' && !p.is_disabled)
  const byDate = new Map<string, number>()
  const endTs = Math.floor(Date.now() / 1000)
  const fromTs = Math.floor(new Date(`${fromDate}T00:00:00Z`).getTime() / 1000)
  await pool(cde, 5, async (p) => {
    const size = parseFloat(p.future_product_details?.contract_size ?? '')
    if (!Number.isFinite(size)) return
    for (let s = fromTs; s < endTs; s += 300 * 86_400) {
      const e = Math.min(s + 300 * 86_400, endTs)
      const { candles } = await fetchJson<{ candles: { start: string; close: string; volume: string }[] }>(
        `https://api.coinbase.com/api/v3/brokerage/market/products/${p.product_id}/candles?start=${s}&end=${e}&granularity=ONE_DAY`
      )
      for (const c of candles ?? []) {
        accumulate(byDate, toDailyDate(parseInt(c.start, 10) * 1000), parseFloat(c.volume) * size * parseFloat(c.close))
      }
    }
  })
  return toPoints(byDate, fromDate)
}

async function kalshiHistory(fromDate: string): Promise<DailyPoint[]> {
  const { markets } = await fetchJson<{ markets: { ticker: string; status: string }[] }>(
    'https://external-api.kalshi.com/trade-api/v2/margin/markets'
  )
  const byDate = new Map<string, number>()
  const startTs = Math.floor(new Date(`${fromDate}T00:00:00Z`).getTime() / 1000)
  const endTs = Math.floor(Date.now() / 1000)
  await pool(
    markets.filter((m) => m.status === 'active').map((m) => m.ticker),
    4,
    async (ticker) => {
      const res = await fetchJson<{
        candlesticks: { end_period_ts: number; volume_notional_value_dollars?: string }[]
      }>(
        `https://external-api.kalshi.com/trade-api/v2/margin/markets/${ticker}/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=1440`
      )
      for (const c of res.candlesticks ?? []) {
        accumulate(byDate, toDailyDate(c.end_period_ts * 1000), parseFloat(c.volume_notional_value_dollars ?? ''))
      }
    }
  )
  return toPoints(byDate, fromDate)
}

async function cmeHistory(fromDate: string): Promise<DailyPoint[]> {
  const byDate = new Map<string, number>()
  for (const asset of ['BTC', 'ETH', 'SOL'] as const) {
    for (const p of await cmeVolumeHistory(asset, fromDate)) accumulate(byDate, p.date, p.value)
  }
  // XRP futures (50,000 XRP contracts) round out CME's crypto suite
  try {
    const data = await fetchJson<{
      chart: {
        result: {
          timestamp: number[]
          indicators: { quote: { volume: (number | null)[]; close: (number | null)[] }[] }
        }[]
      }
    }>('https://query1.finance.yahoo.com/v8/finance/chart/XRP%3DF?interval=1d&range=1y')
    const r = data.chart.result?.[0]
    if (r?.timestamp) {
      const { volume, close } = r.indicators.quote[0]
      r.timestamp.forEach((t, i) => {
        if (volume[i] != null && close[i] != null) {
          accumulate(byDate, new Date(t * 1000).toISOString().slice(0, 10), volume[i]! * 50_000 * close[i]!)
        }
      })
    }
  } catch {
    // XRP optional
  }
  return toPoints(byDate, fromDate)
}

export const TOTAL_HISTORY_VENUES: { venue: VenueId; fn: (fromDate: string) => Promise<DailyPoint[]> }[] = [
  { venue: 'binance', fn: binanceHistory },
  { venue: 'bybit', fn: bybitHistory },
  { venue: 'okx', fn: okxHistory },
  { venue: 'deribit', fn: deribitHistory },
  { venue: 'hyperliquid', fn: hyperliquidHistory },
  { venue: 'kraken', fn: krakenHistory },
  { venue: 'cme', fn: cmeHistory },
  { venue: 'cde', fn: cdeHistory },
  { venue: 'kalshi', fn: kalshiHistory },
  // kraken_us (Bitnomial) publishes no candle history — accumulates from snapshots
]
