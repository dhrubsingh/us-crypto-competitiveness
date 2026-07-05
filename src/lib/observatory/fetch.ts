// Fetch helper for venue APIs. Binance and Bybit geo-block US IPs; the
// deployed app runs in fra1 (vercel.json) where they're reachable, so code
// running on Vercel hits them directly and everything else (local dev, local
// pipeline runs) relays through the deployed /api/proxy route.

const GEO_BLOCKED_HOSTS = new Set(['fapi.binance.com', 'api.bybit.com'])

const PROXY_BASE =
  process.env.OBSERVATORY_PROXY_BASE ??
  'https://dashboard-ten-orpin-60.vercel.app/api/proxy'

const RUNNING_ON_VERCEL = process.env.VERCEL === '1'

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const host = new URL(url).hostname
  const target =
    !RUNNING_ON_VERCEL && GEO_BLOCKED_HOSTS.has(host)
      ? `${PROXY_BASE}?url=${encodeURIComponent(url)}`
      : url

  const res = await fetch(target, {
    ...init,
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0', ...init?.headers },
    signal: init?.signal ?? AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    throw new Error(`${host} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  return res.json() as Promise<T>
}

export function utcDate(ts: number | Date = new Date()): string {
  return new Date(ts).toISOString().slice(0, 10)
}
