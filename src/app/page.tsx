import Dashboard, { AssetSlice, DashboardPayload } from '../components/Dashboard'
import {
  AssetFilter,
  cmeBasisSeries,
  totalOiShareSeries,
  totalVolumeShareSeries,
  fundingSeries,
  headline,
  latestDepth,
  loadObservatory,
  oiShareSeries,
  smooth,
  volumeShareSeries,
} from '../lib/observatory/metrics'
import { VENUES, VenueId } from '../lib/observatory/types'

export const dynamic = 'force-static'

function buildSlice(asset: AssetFilter): AssetSlice {
  const data = loadObservatory()

  const share = smooth(volumeShareSeries(data, asset), 7)
  const oiShare = oiShareSeries(data, asset)
  const funding = fundingSeries(data, asset)
  const basis = cmeBasisSeries(data, asset)

  const fundingByDate = new Map(funding.map((f) => [f.date, f]))
  // 7-day trailing mean: daily basis readings carry close-timing noise
  // (CME settles 4pm CT, spot closes at UTC midnight) that annualization amplifies
  const smoothVals = (vals: (number | null)[], days = 7) =>
    vals.map((_, i) => {
      const window = vals.slice(Math.max(0, i - days + 1), i + 1).filter((v): v is number => v != null)
      return window.length ? window.reduce((a, b) => a + b, 0) / window.length : null
    })
  const basisRaw = basis.map((b) => b.cmeBasisPct)
  const offRaw = basis.map((b) => fundingByDate.get(b.date)?.offshorePct ?? null)
  const basisSm = smoothVals(basisRaw)
  const offSm = smoothVals(offRaw)
  const carry = basis.map((b, i) => ({
    d: b.date,
    cmeBasis: basisSm[i],
    offFunding: offSm[i],
  }))

  // Depth is presented as two groups: the best available book on each side
  // (spread/fill cost = group minimum, i.e. best-execution routing) with
  // resting depth summed across the group's observed books.
  const depthAsset = asset === 'ALL' ? 'BTC' : asset
  const venueRows = latestDepth(data)[depthAsset]
  const depth = (['onshore', 'offshore'] as const).flatMap((region) => {
    const group = venueRows.filter((r) => VENUES[r.venue as VenueId].region === region)
    if (!group.length) return []
    const min = (xs: (number | null)[]) => {
      const fin = xs.filter((x): x is number => x != null)
      return fin.length ? Math.min(...fin) : null
    }
    return [
      {
        venue: region,
        venueName: region === 'onshore' ? 'Onshore' : 'Offshore',
        region,
        spreadBps: Math.min(...group.map((r) => r.spreadBps)),
        cost100k: min(group.map((r) => r.fillCost100kBps)),
        cost1m: min(group.map((r) => r.fillCost1mBps)),
        depth50BpsUsd: group.reduce((s, r) => s + r.depth50BpsUsd, 0),
      },
    ]
  })

  return {
    volumeShare: share.map((p) => ({ d: p.date, share: round(p.sharePct, 2), on: p.onshoreUsd, off: p.offshoreUsd })),
    oiShare: oiShare.map((p) => ({ d: p.date, share: round(p.sharePct, 2), on: p.onshoreUsd, off: p.offshoreUsd })),
    funding: (() => {
      // display composites are 7-day averaged (raw daily means annualize
      // single 8h prints into chart-breaking spikes); per-venue stays raw
      const offSm = smoothVals(funding.map((p) => p.offshorePct))
      const onSm = smoothVals(funding.map((p) => p.onshorePct))
      return funding.map((p, i) => ({
        d: p.date,
        off: round(offSm[i], 2),
        on: round(onSm[i], 2),
        cde: round(p.cdePct, 2),
        kalshi: round(p.kalshiPct, 2),
        krakenUs: round(p.krakenUsPct, 2),
      }))
    })(),
    carry: carry.map((p) => ({ d: p.d, cmeBasis: round(p.cmeBasis, 2), offFunding: round(p.offFunding, 2) })),
    depth,
  }
}

function round(v: number | null, digits: number): number | null {
  return v == null ? null : +v.toFixed(digits)
}

// "Everything listed": venue-wide totals for share charts; funding/carry/depth
// are contract-level measures and reuse the majors slice (see section 2 dek)
function buildTotalSlice(): AssetSlice {
  const data = loadObservatory()
  const majors = buildSlice('ALL')
  const share = smooth(totalVolumeShareSeries(data), 7)
  const oiShare = totalOiShareSeries(data)
  return {
    ...majors,
    volumeShare: share.map((p) => ({ d: p.date, share: round(p.sharePct, 2), on: p.onshoreUsd, off: p.offshoreUsd })),
    oiShare: oiShare.map((p) => ({ d: p.date, share: round(p.sharePct, 2), on: p.onshoreUsd, off: p.offshoreUsd })),
  }
}

function buildGap(): DashboardPayload['gap'] {
  const data = loadObservatory()
  const rows = data.listingGap?.rows ?? []
  const missing = rows.filter((r) => r.onshoreVenues.length === 0 && r.offshoreVolumeUsd > 0)
  const offVol = rows.reduce((s, r) => s + r.offshoreVolumeUsd, 0)
  const missVol = missing.reduce((s, r) => s + r.offshoreVolumeUsd, 0)

  const byCat = new Map<string, number>()
  for (const r of missing) byCat.set(r.category, (byCat.get(r.category) ?? 0) + r.offshoreVolumeUsd)

  return {
    generatedAt: data.listingGap?.generatedAt ?? '',
    totalUnderlyings: rows.filter((r) => r.offshoreVenues.length > 0).length,
    usListedCount: rows.filter((r) => r.offshoreVenues.length > 0 && r.onshoreVenues.length > 0).length,
    missingVolPct: offVol > 0 ? +((missVol / offVol) * 100).toFixed(1) : 0,
    missingByCategoryUsd: [...byCat.entries()]
      .map(([category, usd]) => ({ category, usd }))
      .sort((a, b) => b.usd - a.usd),
    topMissing: missing.slice(0, 14).map((r) => ({
      underlying: r.underlying,
      category: r.category,
      offshoreVenues: r.offshoreVenues,
      offshoreVolumeUsd: r.offshoreVolumeUsd,
    })),
    onshoreOnly: rows
      .filter((r) => r.offshoreVenues.length === 0 && r.onshoreVolumeUsd > 0)
      .sort((a, b) => b.onshoreVolumeUsd - a.onshoreVolumeUsd)
      .map((r) => ({ underlying: r.underlying, category: r.category, onshoreVolumeUsd: r.onshoreVolumeUsd })),
    all: rows.map((r) => ({
      underlying: r.underlying,
      category: r.category,
      offshoreVenues: r.offshoreVenues,
      onshoreVenues: r.onshoreVenues,
      offshoreVolumeUsd: r.offshoreVolumeUsd,
    })),
  }
}

export default function Page() {
  const data = loadObservatory()
  const h = headline(data)

  const payload: DashboardPayload = {
    updated: h.asOf,
    headline: {
      volumeShare7dPct: round(h.volumeShare7dPct, 1),
      volumeShareDelta30dPct: round(h.volumeShareDelta30dPct, 1),
      onshoreOiUsd: h.onshoreOiUsd,
      oiSharePct: round(h.oiSharePct, 1),
      fundingDivergencePct: round(h.fundingDivergencePct, 1),
      executionGapBps: round(h.executionGapBps, 2),
    },
    slices: {
      ALL: buildSlice('ALL'),
      BTC: buildSlice('BTC'),
      ETH: buildSlice('ETH'),
      SOL: buildSlice('SOL'),
      TOTAL: buildTotalSlice(),
    },
    events: data.events,
    gap: buildGap(),
  }

  return <Dashboard payload={payload} />
}
