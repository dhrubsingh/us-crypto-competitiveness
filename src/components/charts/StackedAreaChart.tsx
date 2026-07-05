'use client'

import { useMemo, useState } from 'react'
import { fmtDate, fmtDateDay, fmtDateShort } from '../../lib/format'
import {
  dateToMs,
  linearScale,
  niceTicks,
  stackEventFlags,
  useContainerWidth,
  xTickDates,
  yTickFormat,
  yValueFormat,
} from './chartUtils'
import type { ChartEvent } from './TimeSeriesChart'

// Stacked band chart for the weekly CFTC onshore OI series. Bands are a light
// wash with a 2px top edge in the band's hue; a 2px surface stroke separates
// the stack (the "surface gap" for area fills).

export interface StackBand {
  id: string
  label: string
  color: string
}

interface Props {
  dates: string[]
  bands: StackBand[]
  /** values[bandIndex][dateIndex] */
  values: (number | null)[][]
  events?: ChartEvent[]
  height?: number
  /** Label for the tooltip total row (shown when ≥2 bands). */
  totalLabel?: string
  /** When set, the tooltip adds "<shareLabel> x.x%" = band 0 ÷ total. */
  shareLabel?: string
}

const M = { top: 16, right: 12, bottom: 26, left: 48 }

export default function StackedAreaChart({
  dates,
  bands,
  values,
  events,
  height = 280,
  totalLabel = 'Total',
  shareLabel,
}: Props) {
  const [wrapRef, width] = useContainerWidth<HTMLDivElement>()
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  const plotW = Math.max(120, width - M.left - M.right)
  const plotH = height - M.top - M.bottom

  const totals = useMemo(
    () => dates.map((_, di) => bands.reduce((sum, _b, bi) => sum + (values[bi][di] ?? 0), 0)),
    [dates, bands, values]
  )

  const { x, y, ticks } = useMemo(() => {
    const xs = linearScale([dateToMs(dates[0]), dateToMs(dates[dates.length - 1])], [M.left, M.left + plotW])
    const hi = Math.max(...totals, 1) * 1.08
    const tk = niceTicks(0, hi, 4)
    const ys = linearScale([0, hi], [M.top + plotH, M.top])
    return { x: xs, y: ys, ticks: tk }
  }, [dates, totals, plotW, plotH])

  // cumulative tops per band (band 0 at the bottom)
  const stackTops = useMemo(() => {
    const cum: number[][] = []
    let running = dates.map(() => 0)
    for (let bi = 0; bi < bands.length; bi++) {
      running = running.map((r, di) => r + (values[bi][di] ?? 0))
      cum.push([...running])
    }
    return cum
  }, [dates, bands, values])

  const areaPath = (bi: number) => {
    const top = stackTops[bi]
    const bottom = bi === 0 ? dates.map(() => 0) : stackTops[bi - 1]
    let d = ''
    for (let i = 0; i < dates.length; i++) {
      const px = x(dateToMs(dates[i]))
      d += `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${y(top[i]).toFixed(1)}`
    }
    for (let i = dates.length - 1; i >= 0; i--) {
      const px = x(dateToMs(dates[i]))
      d += `L${px.toFixed(1)},${y(bottom[i]).toFixed(1)}`
    }
    return d + 'Z'
  }

  const edgePath = (bi: number) => {
    const top = stackTops[bi]
    let d = ''
    for (let i = 0; i < dates.length; i++) {
      const px = x(dateToMs(dates[i]))
      d += `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${y(top[i]).toFixed(1)}`
    }
    return d
  }

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

  const tickFmt = yTickFormat('usd')
  const valFmt = yValueFormat('usd')
  const { ticks: xTicks, dayLevel } = useMemo(() => xTickDates(dates), [dates])
  const xFmt = dayLevel ? fmtDateDay : fmtDateShort
  const hoverDate = hoverIdx != null ? dates[hoverIdx] : null
  const tooltipLeft = hoverDate ? x(dateToMs(hoverDate)) : 0
  const tooltipFlip = tooltipLeft > M.left + plotW * 0.62

  return (
    <div ref={wrapRef} className="relative">
      {bands.length > 1 && (
        <div className="mb-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-[var(--ink-2)]">
          {bands.map((b) => (
            <span key={b.id} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: b.color, opacity: 0.75 }} />
              {b.label}
            </span>
          ))}
        </div>
      )}
      <svg width={width} height={height} role="img" className="block select-none">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={M.left + plotW} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
            <text x={M.left - 8} y={y(t) + 3.5} textAnchor="end" fontSize={10.5} fill="var(--ink-3)" className="tnum">
              {tickFmt(t)}
            </text>
          </g>
        ))}
        {xTicks.map((d) => (
          <text key={d} x={x(dateToMs(d))} y={M.top + plotH + 17} textAnchor="middle" fontSize={10.5} fill="var(--ink-3)">
            {xFmt(d)}
          </text>
        ))}
        {bands.map((b, bi) => (
          <g key={b.id}>
            <path d={areaPath(bi)} fill={b.color} opacity={0.22} />
            <path d={areaPath(bi)} fill="none" stroke="var(--surface)" strokeWidth={2} />
            <path d={edgePath(bi)} fill="none" stroke={b.color} strokeWidth={2} strokeLinejoin="round" />
          </g>
        ))}
        {stackEventFlags(events, x).map(({ ev, ex, level }) => (
          <g key={`${ev.date}-${ev.n}`}>
            <line x1={ex} x2={ex} y1={M.top + 8} y2={M.top + plotH} stroke="var(--border-strong)" strokeWidth={1} />
            <circle cx={ex} cy={M.top + 2 + level * 17} r={7.5} fill="var(--surface-2)" stroke="var(--border-strong)" strokeWidth={1} />
            <text x={ex} y={M.top + 5 + level * 17} textAnchor="middle" fontSize={9} fontWeight={600} fill="var(--ink-2)">
              {ev.n}
            </text>
            <title>{`${fmtDate(ev.date)} — ${ev.title}`}</title>
          </g>
        ))}
        {hoverDate != null && (
          <line
            x1={x(dateToMs(hoverDate))}
            x2={x(dateToMs(hoverDate))}
            y1={M.top}
            y2={M.top + plotH}
            stroke="var(--ink-3)"
            strokeWidth={1}
            pointerEvents="none"
          />
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
      {hoverIdx != null && hoverDate != null && (
        <div
          className="pointer-events-none absolute z-10 min-w-[180px] rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-2 shadow-sm"
          style={{
            top: M.top,
            left: tooltipFlip ? undefined : tooltipLeft + 12,
            right: tooltipFlip ? width - tooltipLeft + 12 : undefined,
          }}
        >
          <div className="mb-1 text-[11px] text-[var(--ink-3)]">Week of {fmtDate(hoverDate)}</div>
          {bands.map((b, bi) => (
            <div key={b.id} className="flex items-center justify-between gap-4 py-px text-[12px]">
              <span className="inline-flex items-center gap-1.5 text-[var(--ink-2)]">
                <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: b.color, opacity: 0.75 }} />
                {b.label}
              </span>
              <span className="tnum font-semibold text-[var(--ink)]">
                {values[bi][hoverIdx] == null ? '—' : valFmt(values[bi][hoverIdx]!)}
              </span>
            </div>
          ))}
          {bands.length > 1 && (
            <div className="mt-1 border-t border-[var(--border)] pt-1">
              <div className="flex items-center justify-between gap-4 py-px text-[12px]">
                <span className="text-[var(--ink-2)]">{totalLabel}</span>
                <span className="tnum font-semibold text-[var(--ink)]">{valFmt(totals[hoverIdx])}</span>
              </div>
              {shareLabel && totals[hoverIdx] > 0 && (
                <div className="flex items-center justify-between gap-4 py-px text-[12px]">
                  <span className="text-[var(--ink-2)]">{shareLabel}</span>
                  <span className="tnum font-semibold text-[var(--ink)]">
                    {(((values[0][hoverIdx] ?? 0) / totals[hoverIdx]) * 100).toFixed(1)}%
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
