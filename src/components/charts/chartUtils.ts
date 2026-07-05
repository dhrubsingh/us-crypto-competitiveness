'use client'

import { useEffect, useRef, useState } from 'react'

export interface SeriesPoint {
  d: string // YYYY-MM-DD
  v: number | null
}

export interface ChartSeries {
  id: string
  label: string
  /** Short form used for direct end labels (falls back to label). */
  short?: string
  color: string
  points: SeriesPoint[]
  /** Context series render slightly thinner and never take direct labels. */
  context?: boolean
}

export type YFormat = 'pct' | 'usd' | 'pctPa'

export function useContainerWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(720)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width]
}

export const dateToMs = (d: string) => new Date(`${d}T00:00:00Z`).getTime()

export function linearScale(domain: [number, number], range: [number, number]) {
  const [d0, d1] = domain
  const [r0, r1] = range
  const span = d1 - d0 || 1
  return (x: number) => r0 + ((x - d0) / span) * (r1 - r0)
}

/** ~n clean tick values covering [min, max]. */
export function niceTicks(min: number, max: number, n = 4): number[] {
  if (min === max) {
    max = min + 1
  }
  const span = max - min
  const step0 = span / n
  const mag = 10 ** Math.floor(Math.log10(step0))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n + 0.5) ?? 10 * mag
  const start = Math.ceil(min / step) * step
  const ticks: number[] = []
  for (let t = start; t <= max + step * 1e-9; t += step) ticks.push(Math.round(t * 1e9) / 1e9)
  return ticks
}

/** Merge all series dates, sorted ascending. */
export function unionDates(series: ChartSeries[]): string[] {
  const set = new Set<string>()
  for (const s of series) for (const p of s.points) set.add(p.d)
  return [...set].sort()
}

/**
 * Lay out event flags left-to-right, bumping a flag down a level when its
 * circle would overlap the previous one at the same level (clustered dates).
 */
export function stackEventFlags<E extends { date: string; n: number }>(
  events: E[] | undefined,
  x: (ms: number) => number,
  minGap = 17
): { ev: E; ex: number; level: number }[] {
  if (!events?.length) return []
  const placed: { ev: E; ex: number; level: number }[] = []
  const lastAtLevel: number[] = []
  for (const ev of [...events].sort((a, b) => a.date.localeCompare(b.date))) {
    const ex = x(dateToMs(ev.date))
    let level = 0
    while (lastAtLevel[level] != null && ex - lastAtLevel[level] < minGap) level++
    lastAtLevel[level] = ex
    placed.push({ ev, ex, level })
  }
  return placed
}

export function yTickFormat(fmt: YFormat): (v: number) => string {
  if (fmt === 'pct') return (v) => `${v}%`
  if (fmt === 'pctPa') return (v) => `${v}%`
  return (v) => {
    const abs = Math.abs(v)
    if (abs >= 1e9) return `$${+(v / 1e9).toFixed(1)}B`
    if (abs >= 1e6) return `$${+(v / 1e6).toFixed(0)}M`
    if (abs >= 1e3) return `$${+(v / 1e3).toFixed(0)}K`
    return `$${v}`
  }
}

export function yValueFormat(fmt: YFormat): (v: number) => string {
  if (fmt === 'pct') return (v) => `${v.toFixed(1)}%`
  if (fmt === 'pctPa') return (v) => `${v.toFixed(1)}% p.a.`
  return (v) => {
    const abs = Math.abs(v)
    if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`
    if (abs >= 1e6) return `$${(v / 1e6).toFixed(1)}M`
    if (abs >= 1e3) return `$${(v / 1e3).toFixed(0)}K`
    return `$${v.toFixed(0)}`
  }
}

/**
 * Pick ~5 x-axis tick dates, snapped to month starts where possible. Short
 * spans (≤ ~2 months) fall back to evenly spaced days and day-level labels.
 */
export function xTickDates(dates: string[]): { ticks: string[]; dayLevel: boolean } {
  if (dates.length <= 6) return { ticks: dates, dayLevel: true }
  const monthFirsts = new Map<string, string>()
  for (const d of dates) {
    const ym = d.slice(0, 7)
    if (!monthFirsts.has(ym)) monthFirsts.set(ym, d)
  }
  const firsts = [...monthFirsts.values()]
  if (firsts.length <= 2) {
    const step = Math.ceil(dates.length / 5)
    return { ticks: dates.filter((_, i) => i % step === 0), dayLevel: true }
  }
  const step = Math.max(1, Math.ceil(firsts.length / 6))
  return { ticks: firsts.filter((_, i) => i % step === 0), dayLevel: false }
}
