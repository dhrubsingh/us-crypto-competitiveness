'use client'

import { useMemo, useState } from 'react'
import { fmtDate, fmtDateDay, fmtDateShort } from '../../lib/format'
import {
  ChartSeries,
  YFormat,
  dateToMs,
  linearScale,
  niceTicks,
  stackEventFlags,
  unionDates,
  useContainerWidth,
  xTickDates,
  yTickFormat,
  yValueFormat,
} from './chartUtils'

export interface ChartEvent {
  date: string
  n: number
  title: string
}

interface Props {
  series: ChartSeries[]
  yFmt: YFormat
  height?: number
  zeroLine?: boolean
  events?: ChartEvent[]
  /** Clamp the y-domain (e.g. [0, 100] for shares). Missing side = auto. */
  yMin?: number
  yMax?: number
  /** Shade the region between two series (by id) where both have values. */
  fillBetween?: [string, string]
}

const M = { top: 14, right: 84, bottom: 26, left: 44 }

export default function TimeSeriesChart({
  series,
  yFmt,
  height = 240,
  zeroLine,
  events,
  yMin,
  yMax,
  fillBetween,
}: Props) {
  const [wrapRef, width] = useContainerWidth<HTMLDivElement>()
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  const dates = useMemo(() => unionDates(series), [series])
  const byDate = useMemo(() => {
    const maps = series.map((s) => new Map(s.points.map((p) => [p.d, p.v])))
    return (d: string, i: number) => maps[i].get(d) ?? null
  }, [series])

  const plotW = Math.max(120, width - M.left - M.right)
  const plotH = height - M.top - M.bottom

  const { x, y, ticks } = useMemo(() => {
    const t0 = dateToMs(dates[0] ?? '2026-01-01')
    const t1 = dateToMs(dates[dates.length - 1] ?? '2026-01-02')
    const xs = linearScale([t0, t1], [M.left, M.left + plotW])

    let lo = Infinity
    let hi = -Infinity
    for (const s of series)
      for (const p of s.points)
        if (p.v != null && Number.isFinite(p.v)) {
          lo = Math.min(lo, p.v)
          hi = Math.max(hi, p.v)
        }
    if (!Number.isFinite(lo)) {
      lo = 0
      hi = 1
    }
    if (zeroLine) {
      lo = Math.min(lo, 0)
      hi = Math.max(hi, 0)
    }
    if (yMin != null) lo = yMin
    if (yMax != null) hi = Math.min(Math.max(hi * 1.05, lo + 0.001), yMax)
    else hi = hi + (hi - lo) * 0.06
    const tk = niceTicks(lo, hi, 4)
    const ys = linearScale([lo, hi], [M.top + plotH, M.top])
    return { x: xs, y: ys, ticks: tk }
  }, [dates, series, plotW, plotH, zeroLine, yMin, yMax])

  const pathFor = (s: ChartSeries) => {
    let d = ''
    let pen = false
    for (const p of s.points) {
      if (p.v == null || !Number.isFinite(p.v)) {
        pen = false
        continue
      }
      const px = x(dateToMs(p.d))
      const py = y(p.v)
      d += pen ? ` L${px.toFixed(1)},${py.toFixed(1)}` : ` M${px.toFixed(1)},${py.toFixed(1)}`
      pen = true
    }
    return d
  }

  // Direct end labels: only when ≥2 series (a lone series is named by the
  // title) and only for non-context series whose endpoints don't collide.
  // Cheap enough to compute per render; the React Compiler memoizes it.
  const endLabels = (() => {
    if (series.length < 2) return []
    const cands = series
      .filter((s) => !s.context)
      .map((s) => {
        const last = [...s.points].reverse().find((p) => p.v != null && Number.isFinite(p.v))
        return last ? { label: s.short ?? s.label, color: s.color, yPos: y(last.v!) } : null
      })
      .filter((c): c is NonNullable<typeof c> => c != null)
      .sort((a, b) => a.yPos - b.yPos)
    for (let i = 1; i < cands.length; i++) {
      if (cands[i].yPos - cands[i - 1].yPos < 14) return [] // converging → legend carries identity
    }
    return cands
  })()

  const hoverDate = hoverIdx != null ? dates[hoverIdx] : null

  function onMove(e: React.PointerEvent<SVGRectElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left + M.left
    let best = 0
    let bestDist = Infinity
    for (let i = 0; i < dates.length; i++) {
      const dist = Math.abs(x(dateToMs(dates[i])) - px)
      if (dist < bestDist) {
        bestDist = dist
        best = i
      }
    }
    setHoverIdx(best)
  }

  const tickFmt = yTickFormat(yFmt)
  const valFmt = yValueFormat(yFmt)
  const { ticks: xTicks, dayLevel } = useMemo(() => xTickDates(dates), [dates])
  const xFmt = dayLevel ? fmtDateDay : fmtDateShort

  const showLegend = series.length >= 2
  const tooltipLeft = hoverDate != null ? x(dateToMs(hoverDate)) : 0
  const tooltipFlip = tooltipLeft > M.left + plotW * 0.62

  return (
    <div ref={wrapRef} className="relative">
      {showLegend && (
        <div className="mb-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-[var(--ink-2)]">
          {series.map((s) => (
            <span key={s.id} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-[2px] w-4 rounded" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <svg width={width} height={height} role="img" className="block select-none">
        {/* y grid + ticks */}
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={M.left}
              x2={M.left + plotW}
              y1={y(t)}
              y2={y(t)}
              stroke={zeroLine && t === 0 ? 'var(--border-strong)' : 'var(--border)'}
              strokeWidth={1}
            />
            <text x={M.left - 8} y={y(t) + 3.5} textAnchor="end" fontSize={10.5} fill="var(--ink-3)" className="tnum">
              {tickFmt(t)}
            </text>
          </g>
        ))}
        {/* x ticks */}
        {xTicks.map((d) => (
          <text
            key={d}
            x={x(dateToMs(d))}
            y={M.top + plotH + 17}
            textAnchor="middle"
            fontSize={10.5}
            fill="var(--ink-3)"
          >
            {xFmt(d)}
          </text>
        ))}
        {/* event flags */}
        {stackEventFlags(events, x).map(({ ev, ex, level }) => {
          if (ex < M.left - 1 || ex > M.left + plotW + 1) return null
          return (
            <g key={`${ev.date}-${ev.n}`}>
              <line x1={ex} x2={ex} y1={M.top + 8} y2={M.top + plotH} stroke="var(--border-strong)" strokeWidth={1} />
              <circle cx={ex} cy={M.top + 2 + level * 17} r={7.5} fill="var(--surface-2)" stroke="var(--border-strong)" strokeWidth={1} />
              <text x={ex} y={M.top + 5 + level * 17} textAnchor="middle" fontSize={9} fontWeight={600} fill="var(--ink-2)">
                {ev.n}
              </text>
              <title>{`${fmtDate(ev.date)} — ${ev.title}`}</title>
            </g>
          )
        })}
        {/* gap band between two series (the visual "premium") */}
        {fillBetween &&
          (() => {
            const a = series.find((s) => s.id === fillBetween[0])
            const b = series.find((s) => s.id === fillBetween[1])
            if (!a || !b) return null
            const mapB = new Map(b.points.map((p) => [p.d, p.v]))
            const pairs = a.points
              .map((p) => ({ d: p.d, va: p.v, vb: mapB.get(p.d) ?? null }))
              .filter((p) => p.va != null && p.vb != null && Number.isFinite(p.va) && Number.isFinite(p.vb))
            if (pairs.length < 2) return null
            let d = ''
            pairs.forEach((p, i) => {
              d += `${i === 0 ? 'M' : 'L'}${x(dateToMs(p.d)).toFixed(1)},${y(p.va!).toFixed(1)}`
            })
            for (let i = pairs.length - 1; i >= 0; i--) {
              d += `L${x(dateToMs(pairs[i].d)).toFixed(1)},${y(pairs[i].vb!).toFixed(1)}`
            }
            return <path d={d + 'Z'} fill="var(--accent)" opacity={0.12} />
          })()}
        {/* series lines */}
        {series.map((s) => (
          <path
            key={s.id}
            d={pathFor(s)}
            fill="none"
            stroke={s.color}
            strokeWidth={s.context ? 1.5 : 2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {/* direct end labels */}
        {endLabels.map((l) => (
          <text
            key={l.label}
            x={M.left + plotW + 6}
            y={l.yPos + 3.5}
            fontSize={11}
            fill="var(--ink-2)"
          >
            {l.label}
          </text>
        ))}
        {/* crosshair + hover markers */}
        {hoverDate != null && (
          <g pointerEvents="none">
            <line
              x1={x(dateToMs(hoverDate))}
              x2={x(dateToMs(hoverDate))}
              y1={M.top}
              y2={M.top + plotH}
              stroke="var(--ink-3)"
              strokeWidth={1}
            />
            {series.map((s, i) => {
              const v = byDate(hoverDate, i)
              if (v == null) return null
              return (
                <circle
                  key={s.id}
                  cx={x(dateToMs(hoverDate))}
                  cy={y(v)}
                  r={4}
                  fill={s.color}
                  stroke="var(--surface)"
                  strokeWidth={2}
                />
              )
            })}
          </g>
        )}
        <rect
          x={M.left}
          y={M.top}
          width={plotW}
          height={plotH}
          fill="transparent"
          onPointerMove={onMove}
          onPointerLeave={() => setHoverIdx(null)}
        />
      </svg>
      {hoverDate != null && (
        <div
          className="pointer-events-none absolute z-10 min-w-[150px] rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-2 shadow-sm"
          style={{
            top: M.top,
            left: tooltipFlip ? undefined : tooltipLeft + 12,
            right: tooltipFlip ? width - tooltipLeft + 12 : undefined,
          }}
        >
          <div className="mb-1 text-[11px] text-[var(--ink-3)]">{fmtDate(hoverDate)}</div>
          {series.map((s, i) => {
            const v = byDate(hoverDate, i)
            return (
              <div key={s.id} className="flex items-center justify-between gap-4 py-px text-[12px]">
                <span className="inline-flex items-center gap-1.5 text-[var(--ink-2)]">
                  <span className="inline-block h-[2px] w-3.5 rounded" style={{ background: s.color }} />
                  {s.label}
                </span>
                <span className="tnum font-semibold text-[var(--ink)]">{v == null ? '—' : valFmt(v)}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
