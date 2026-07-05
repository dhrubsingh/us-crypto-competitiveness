import { NextRequest } from 'next/server'

// Relay for venue APIs that geo-block US IPs (Binance, Bybit). This app deploys
// to fra1 (see vercel.json), where those endpoints are reachable, so local
// ingest and dev servers route their calls through here.
export const dynamic = 'force-dynamic'

const ALLOWED_HOSTS = new Set([
  'fapi.binance.com',
  'api.bybit.com',
  'www.binance.com',
])

export async function GET(request: NextRequest) {
  const target = request.nextUrl.searchParams.get('url')
  if (!target) {
    return Response.json({ error: 'missing url param' }, { status: 400 })
  }

  let parsed: URL
  try {
    parsed = new URL(target)
  } catch {
    return Response.json({ error: 'invalid url' }, { status: 400 })
  }

  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
    return Response.json({ error: 'host not allowed' }, { status: 403 })
  }

  try {
    const upstream = await fetch(parsed.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
      cache: 'no-store',
    })
    const body = await upstream.text()
    return new Response(body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    return Response.json(
      { error: `upstream fetch failed: ${err instanceof Error ? err.message : 'unknown'}` },
      { status: 502 }
    )
  }
}
