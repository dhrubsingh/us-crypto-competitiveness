'use client'

import { fmtUsd } from '../../lib/format'

// Execution-quality comparison: table + inline bars (cost in bps to fill a
// market order, one-way, vs mid). Onshore venue bars wear the accent hue,
// offshore bars the context gray — identity is also written in the Region
// column, never color alone.

export interface DepthTableRow {
  venue: string
  venueName: string
  region: 'onshore' | 'offshore'
  spreadBps: number
  cost100k: number | null
  cost1m: number | null
  depth50BpsUsd: number
}

interface Props {
  rows: DepthTableRow[]
}

function CostCell({ value, max, onshore }: { value: number | null; max: number; onshore: boolean }) {
  if (value == null) {
    return <span className="text-[12px] text-[var(--ink-3)]">book too thin</span>
  }
  const w = Math.max(2, (value / max) * 100)
  return (
    <div className="flex items-center gap-2">
      <div className="h-3 flex-1 rounded-[2px] bg-[var(--surface-2)]">
        <div
          className="h-3 rounded-[2px]"
          style={{ width: `${Math.min(100, w)}%`, background: onshore ? 'var(--accent)' : 'var(--offshore)' }}
        />
      </div>
      <span className="tnum w-14 shrink-0 text-right text-[12px] text-[var(--ink)]">{value.toFixed(2)}</span>
    </div>
  )
}

export default function DepthTable({ rows }: Props) {
  const max = Math.max(...rows.flatMap((r) => [r.cost100k ?? 0, r.cost1m ?? 0]), 0.1)
  const sorted = [...rows].sort((a, b) =>
    a.region === b.region ? (a.cost1m ?? Infinity) - (b.cost1m ?? Infinity) : a.region === 'onshore' ? -1 : 1
  )

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-[var(--border-strong)] text-left text-[11px] uppercase tracking-wider text-[var(--ink-3)]">
            <th className="py-2 pr-3 font-medium">Group</th>
            <th className="py-2 pr-3 text-right font-medium">Best spread (bps)</th>
            <th className="w-[28%] py-2 pr-3 font-medium">$100K fill cost (bps)</th>
            <th className="w-[28%] py-2 pr-3 font-medium">$1M fill cost (bps)</th>
            <th className="py-2 text-right font-medium">Total depth ±50 bps</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => {
            const firstOffshore = r.region === 'offshore' && sorted[i - 1]?.region === 'onshore'
            return (
              <tr
                key={r.venue}
                className={`border-b border-[var(--border)] ${firstOffshore ? 'border-t border-t-[var(--border-strong)]' : ''}`}
              >
                <td className="py-2 pr-3">
                  <span className="font-medium text-[var(--ink)]">{r.venueName}</span>
                  <span
                    className={`ml-2 rounded-sm px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-wide ${
                      r.region === 'onshore'
                        ? 'bg-[#e7f0fb] text-[#1c5cab]'
                        : 'bg-[var(--surface-2)] text-[var(--ink-2)]'
                    }`}
                  >
                    {r.region === 'onshore' ? 'US / CFTC' : 'Offshore'}
                  </span>
                </td>
                <td className="tnum py-2 pr-3 text-right text-[var(--ink)]">{r.spreadBps.toFixed(2)}</td>
                <td className="py-2 pr-3">
                  <CostCell value={r.cost100k} max={max} onshore={r.region === 'onshore'} />
                </td>
                <td className="py-2 pr-3">
                  <CostCell value={r.cost1m} max={max} onshore={r.region === 'onshore'} />
                </td>
                <td className="tnum py-2 text-right text-[var(--ink)]">{fmtUsd(r.depth50BpsUsd)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
