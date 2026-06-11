'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';

// All ECharts modules live in the child component (`./observation-chart-impl`)
// so Next bundles them as a single chunk. Earlier we did Promise.all over five
// separate `import('echarts/...')` calls; in dev that meant the dev server had
// to compile five barrels on demand and serialised them in its compile queue,
// pushing first chart paint past 5 s.
const ReactECharts = dynamic(() => import('./observation-chart-impl.tsx'), {
  ssr: false,
  // Reserve the chart's height so the page doesn't shift when the bundle
  // arrives, and render a pulsing skeleton so the user sees activity.
  loading: () => (
    <div
      className="animate-pulse bg-gray-100 rounded"
      style={{ height: 360 }}
      aria-label="グラフ読み込み中"
    />
  ),
});

export interface SeriesPoint {
  observedAt: string;
  storageVolumeM3: string | null;
  storageRate: string | null;
  inflowM3s: string | null;
  outflowM3s: string | null;
  qualityFlag: number;
  sourceId: string;
}

export function ObservationChart({
  slug,
  capacityM3,
  kind = 'dam',
}: {
  slug: string;
  capacityM3?: number | null;
  // Default 'dam' so existing dam-detail pages keep working unchanged.
  kind?: 'dam' | 'watershed';
}) {
  const [interval, setInterval] = useState<'hourly' | 'daily' | 'monthly'>('daily');
  const [points, setPoints] = useState<SeriesPoint[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setPoints(null);
    setErr(null);
    const to = new Date();
    const fromDate = new Date();
    if (interval === 'hourly') fromDate.setUTCDate(fromDate.getUTCDate() - 7);
    else if (interval === 'daily') fromDate.setUTCFullYear(fromDate.getUTCFullYear() - 1);
    else fromDate.setUTCFullYear(fromDate.getUTCFullYear() - 5);
    const base = kind === 'watershed' ? '/api/v1/watersheds' : '/api/v1/dams';
    const url = `${base}/${slug}/observations?from=${fromDate.toISOString()}&to=${to.toISOString()}&interval=${interval}`;
    fetch(
      url,
      process.env.NEXT_PUBLIC_API_KEY
        ? { headers: { Authorization: `Bearer ${process.env.NEXT_PUBLIC_API_KEY}` } }
        : {},
    )
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = (await r.json()) as { series: SeriesPoint[] };
        setPoints(body.series);
      })
      .catch((e: Error) => setErr(e.message));
  }, [interval, slug, kind]);

  if (err) return <div className="text-red-700 text-sm">グラフを取得できませんでした: {err}</div>;
  if (!points)
    return (
      <div
        className="animate-pulse bg-gray-100 rounded"
        style={{ height: 360 }}
        aria-label="グラフ読み込み中"
      />
    );

  const volumeData: Array<[string, number | null]> = points.map((p) => [
    p.observedAt,
    p.storageVolumeM3 ? Number(p.storageVolumeM3) : null,
  ]);
  // Subset of points carrying real-source observations (anything other than
  // 'synthetic'). Plotted as discrete green dots on top of the volume line
  // so users can see at a glance where the trend is grounded in measured
  // values vs. seed/placeholder values. Daily/monthly continuous aggregates
  // currently expose the source_id of the last point in each bucket, so the
  // marker density tracks the genuine cadence of the upstream feed.
  const realVolumePoints: Array<[string, number]> = [];
  for (const p of points) {
    if (p.sourceId && p.sourceId !== 'synthetic' && p.storageVolumeM3) {
      realVolumePoints.push([p.observedAt, Number(p.storageVolumeM3)]);
    }
  }
  // Storage rate either comes directly from the API or is derived from
  // volume / capacity when the aggregate omits it (continuous aggregates
  // currently expose avg_storage_volume_m3 only).
  const rateData: Array<[string, number | null]> = points.map((p) => {
    const direct = p.storageRate ? Number(p.storageRate) : null;
    if (direct != null && Number.isFinite(direct)) {
      // Clamp to [0, 1] to guard against legacy obs_daily rows with wrong scale
      return [p.observedAt, Math.max(0, Math.min(1, direct))];
    }
    if (capacityM3 && capacityM3 > 0 && p.storageVolumeM3) {
      return [p.observedAt, Number(p.storageVolumeM3) / capacityM3];
    }
    return [p.observedAt, null];
  });
  const inflowData: Array<[string, number | null]> = points.map((p) => [
    p.observedAt,
    p.inflowM3s != null ? Number(p.inflowM3s) : null,
  ]);
  const outflowData: Array<[string, number | null]> = points.map((p) => [
    p.observedAt,
    p.outflowM3s != null ? Number(p.outflowM3s) : null,
  ]);
  // Daily / monthly continuous aggregates don't carry inflow/outflow (only
  // last_storage). Hide the lines entirely when no point has a flow value
  // so the legend doesn't dangle.
  const hasFlow = inflowData.some(([, v]) => v != null) || outflowData.some(([, v]) => v != null);

  // Auto-scale axis to 億 (>=1e8) or 万 (>=1e4) so labels stay legible
  // across the 6-orders-of-magnitude range of real reservoir capacities.
  const maxAbs = Math.max(
    capacityM3 ?? 0,
    ...volumeData.map(([, v]) => (v == null ? 0 : Math.abs(v))),
  );
  const useOku = maxAbs >= 100_000_000;
  const volumeAxisFormatter = useOku
    ? (v: number) => `${(v / 100_000_000).toFixed(1)}億`
    : (v: number) => `${(v / 10_000).toFixed(0)}万`;
  const fmtVolume = (v: number) =>
    v >= 100_000_000
      ? `${(v / 100_000_000).toFixed(2)} 億 m³`
      : v >= 10_000
        ? `${Math.round(v / 10_000).toLocaleString('ja-JP')} 万 m³`
        : `${Math.round(v).toLocaleString('ja-JP')} m³`;
  const tipFormatter = (
    params: Array<{
      axisValueLabel: string;
      seriesName: string;
      value: [string, number | null];
      marker: string;
    }>,
  ) => {
    if (!params[0]) return '';
    const lines = params.map((p) => {
      const v = p.value[1];
      let txt: string;
      if (v == null) txt = '—';
      else if (p.seriesName === '貯水率') txt = `${(v * 100).toFixed(1)} %`;
      else if (p.seriesName === '流入量' || p.seriesName === '放流量') txt = `${v.toFixed(2)} m³/s`;
      else txt = fmtVolume(v);
      return `${p.marker} ${p.seriesName}: <b>${txt}</b>`;
    });
    return `${params[0].axisValueLabel}<br/>${lines.join('<br/>')}`;
  };

  const series: Array<Record<string, unknown>> = [
    {
      type: 'line' as const,
      data: volumeData,
      smooth: true,
      sampling: 'lttb' as const,
      showSymbol: false,
      name: '貯水量',
      yAxisIndex: 0,
      lineStyle: { width: 2, color: '#1e6dff' },
      itemStyle: { color: '#1e6dff' },
      // Capacity reference line, only drawn when we know the capacity.
      ...(capacityM3 && capacityM3 > 0
        ? {
            markLine: {
              symbol: 'none',
              lineStyle: { type: 'dashed', color: '#dc2626', width: 1 },
              label: {
                formatter: `総貯水容量 ${fmtVolume(capacityM3)}`,
                position: 'insideEndTop' as const,
                color: '#dc2626',
              },
              data: [{ yAxis: capacityM3 }],
            },
          }
        : {}),
    },
    {
      type: 'line' as const,
      data: rateData,
      smooth: true,
      sampling: 'lttb' as const,
      showSymbol: false,
      name: '貯水率',
      yAxisIndex: 1,
      lineStyle: { width: 1, color: '#16a34a', opacity: 0.7 },
      itemStyle: { color: '#16a34a' },
    },
  ];
  if (realVolumePoints.length > 0) {
    series.push({
      type: 'scatter' as const,
      data: realVolumePoints,
      name: '実測',
      yAxisIndex: 0,
      symbol: 'circle' as const,
      symbolSize: 7,
      itemStyle: { color: '#059669', borderColor: '#fff', borderWidth: 1.5 },
      z: 5,
      tooltip: { show: true },
    });
  }
  if (hasFlow) {
    series.push(
      {
        type: 'line' as const,
        data: inflowData,
        smooth: true,
        sampling: 'lttb' as const,
        showSymbol: false,
        name: '流入量',
        yAxisIndex: 2,
        connectNulls: false,
        lineStyle: { width: 1, color: '#0891b2', opacity: 0.85 },
        itemStyle: { color: '#0891b2' },
      },
      {
        type: 'line' as const,
        data: outflowData,
        smooth: true,
        sampling: 'lttb' as const,
        showSymbol: false,
        name: '放流量',
        yAxisIndex: 2,
        connectNulls: false,
        lineStyle: { width: 1, color: '#ea580c', opacity: 0.85 },
        itemStyle: { color: '#ea580c' },
      },
    );
  }

  const option = {
    grid: { left: 70, right: hasFlow ? 110 : 60, top: 40, bottom: 40 },
    xAxis: { type: 'time' as const },
    yAxis: [
      {
        type: 'value' as const,
        name: '貯水量',
        nameTextStyle: { color: '#1e6dff' },
        axisLabel: { formatter: volumeAxisFormatter, color: '#1e6dff' },
        // Don't anchor at 0 — most reservoirs sit at 50-90% so a 0-baseline
        // squashes the variation into a thin band. Let ECharts pick a tight
        // min (with a small pad below dataMin) and cap at capacity.
        scale: true,
        min: 'dataMin' as const,
        max: capacityM3 && capacityM3 > 0 ? capacityM3 : 'dataMax',
      },
      {
        type: 'value' as const,
        name: '貯水率',
        nameTextStyle: { color: '#16a34a' },
        position: 'right' as const,
        min: 0,
        max: 1,
        axisLabel: {
          color: '#16a34a',
          formatter: (v: number) => `${(v * 100).toFixed(0)}%`,
        },
      },
      // Third axis only present when we have flow data; offset right of the
      // 貯水率 axis so labels don't collide.
      {
        type: 'value' as const,
        name: '流量',
        nameTextStyle: { color: '#0891b2' },
        position: 'right' as const,
        offset: 50,
        axisLabel: {
          color: '#0891b2',
          formatter: (v: number) => `${v.toFixed(0)} m³/s`,
        },
        show: hasFlow,
      },
    ],
    tooltip: { trigger: 'axis' as const, formatter: tipFormatter },
    legend: {
      data: (() => {
        const base = hasFlow ? ['貯水量', '貯水率', '流入量', '放流量'] : ['貯水量', '貯水率'];
        return realVolumePoints.length > 0 ? [...base, '実測'] : base;
      })(),
      top: 0,
      textStyle: { fontSize: 12 },
    },
    series,
    animation: false,
  };

  return (
    <div>
      <div className="flex gap-2 mb-3 text-sm">
        {(['hourly', 'daily', 'monthly'] as const).map((b) => (
          <button
            key={b}
            type="button"
            onClick={() => setInterval(b)}
            className={`px-2 py-1 rounded ${b === interval ? 'bg-accent text-white' : 'bg-gray-100'}`}
          >
            {b === 'hourly' ? '1週間' : b === 'daily' ? '1年' : '5年'}
          </button>
        ))}
      </div>
      <ReactECharts option={option} style={{ height: 360 }} />
      {/* Download / API exploration links — same time window as the rendered chart */}
      <DataLinks slug={slug} kind={kind} interval={interval} />
    </div>
  );
}

function DataLinks({
  slug,
  kind,
  interval,
}: {
  slug: string;
  kind: 'dam' | 'watershed';
  interval: 'hourly' | 'daily' | 'monthly';
}) {
  const to = new Date();
  const fromDate = new Date();
  if (interval === 'hourly') fromDate.setUTCDate(fromDate.getUTCDate() - 7);
  else if (interval === 'daily') fromDate.setUTCFullYear(fromDate.getUTCFullYear() - 1);
  else fromDate.setUTCFullYear(fromDate.getUTCFullYear() - 5);
  const base = kind === 'watershed' ? '/api/v1/watersheds' : '/api/v1/dams';
  const qs = `from=${fromDate.toISOString()}&to=${to.toISOString()}&interval=${interval}`;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-on-surface-variant">
      <span>このデータを取得:</span>
      <a className="text-primary hover:underline" href={`${base}/${slug}/observations?${qs}`}>
        JSON
      </a>
      <a
        className="text-primary hover:underline"
        href={`${base}/${slug}/observations?${qs}&format=csv`}
      >
        CSV ダウンロード
      </a>
    </div>
  );
}
