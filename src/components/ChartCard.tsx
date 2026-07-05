'use client'

import { downloadCsv } from '../lib/format'

interface Props {
  num: string
  title: string
  subtitle?: string
  note?: string
  csv?: { filename: string; build: () => string }
  children: React.ReactNode
}

export default function ChartCard({ num, title, subtitle, note, csv, children }: Props) {
  return (
    <figure className="mt-10">
      <figcaption className="mb-3 flex items-baseline justify-between gap-4">
        <div>
          <div className="text-[13.5px] font-semibold text-[var(--ink)]">
            <span className="mr-2 text-[var(--ink-3)]">{num}</span>
            {title}
          </div>
          {subtitle && <div className="mt-0.5 text-[12.5px] text-[var(--ink-2)]">{subtitle}</div>}
        </div>
        {csv && (
          <button
            onClick={() => downloadCsv(csv.filename, csv.build())}
            className="shrink-0 cursor-pointer text-[11.5px] font-medium tracking-wide text-[var(--ink-3)] hover:text-[var(--ink)]"
          >
            CSV ↓
          </button>
        )}
      </figcaption>
      {children}
      {note && <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--ink-3)]">{note}</p>}
    </figure>
  )
}
