import { Asset, VenueId } from '../types'

/** [price, size in base-asset units] */
export type BookLevel = [number, number]

export interface NormalizedBook {
  bids: BookLevel[]
  asks: BookLevel[]
}

/** One venue × asset reading taken "now". Nulls mean the venue doesn't expose that metric. */
export interface VenueSnapshot {
  venue: VenueId
  asset: Asset
  volumeUsd24h: number | null
  oiUsd: number | null
  /** Funding normalized to the 8h-equivalent rate, in percent. */
  rate8hPct: number | null
  markPrice: number | null
  /** Perp (or perp-style) instrument the mark/funding/book refer to. */
  instrument: string | null
  book: NormalizedBook | null
}

export interface DailyPoint {
  date: string // UTC YYYY-MM-DD
  value: number
}

export function toDailyDate(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10)
}

/** Average one-way execution cost vs mid, in bps, walking one side of the book. Null if the book can't fill the notional. */
export function fillCostBps(levels: BookLevel[], mid: number, notionalUsd: number): number | null {
  let remaining = notionalUsd
  let cost = 0
  for (const [price, size] of levels) {
    const levelUsd = price * size
    const take = Math.min(remaining, levelUsd)
    cost += take * price
    remaining -= take
    if (remaining <= 0) break
  }
  if (remaining > 0) return null
  const avgPrice = cost / notionalUsd
  return Math.abs((avgPrice - mid) / mid) * 10_000
}

/** Total USD resting within ±bps of mid, both sides. */
export function depthWithinBps(book: NormalizedBook, mid: number, bps: number): number {
  const lo = mid * (1 - bps / 10_000)
  const hi = mid * (1 + bps / 10_000)
  let usd = 0
  for (const [p, s] of book.bids) if (p >= lo) usd += p * s
  for (const [p, s] of book.asks) if (p <= hi) usd += p * s
  return usd
}
