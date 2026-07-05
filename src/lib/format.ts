export function fmtUsd(n: number, digits = 1): string {
  const abs = Math.abs(n)
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(digits)}T`
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(digits)}B`
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(digits)}M`
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`
  return `$${n.toFixed(0)}`
}

export function fmtPct(n: number, digits = 1): string {
  return `${n.toFixed(digits)}%`
}

export function fmtSigned(n: number, digits = 1, suffix = ''): string {
  return `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(digits)}${suffix}`
}

export function fmtBps(n: number, digits = 1): string {
  return `${n.toFixed(digits)} bps`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** '2026-07-02' → 'Jul 2, 2026' */
export function fmtDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return `${MONTHS[m - 1]} ${d}, ${y}`
}

/** '2026-07-02' → 'Jul ’26' (axis ticks) */
export function fmtDateShort(date: string): string {
  const [y, m] = date.split('-').map(Number)
  return `${MONTHS[m - 1]} ’${String(y).slice(2)}`
}

/** '2026-07-02' → 'Jul 2' (axis ticks on short spans) */
export function fmtDateDay(date: string): string {
  const [, m, d] = date.split('-').map(Number)
  return `${MONTHS[m - 1]} ${d}`
}

/** Build a CSV string from column headers + rows, quoting as needed. */
export function toCsv(headers: string[], rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => {
    if (v == null) return ''
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [headers.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))].join('\n')
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
