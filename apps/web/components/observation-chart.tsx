'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

export interface SeriesPoint {
  observedAt: string;
  storageVolumeM3: string | null;
  storageRate: string | null;
  qualityFlag: number;
  sourceId: string;
}

export function ObservationChart({ slug }: { slug: string }) {
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
    const url = `/api/v1/dams/${slug}/observations?from=${fromDate.toISOString()}&to=${to.toISOString()}&interval=${interval}`;
    fetch(url, { headers: { 'x-api-key': process.env.NEXT_PUBLIC_API_KEY ?? '' } })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = (await r.json()) as { series: SeriesPoint[] };
        setPoints(body.series);
      })
      .catch((e: Error) => setErr(e.message));
  }, [interval, slug]);

  if (err) return <div className="text-red-700 text-sm">グラフを取得できませんでした: {err}</div>;
  if (!points) return <div className="text-muted text-sm">読み込み中…</div>;

  const data: Array<[string, number | null]> = points.map((p) => [
    p.observedAt,
    p.storageVolumeM3 ? Number(p.storageVolumeM3) : null,
  ]);

  // Auto-scale axis to 億 (>=1e8) or 万 (>=1e4) so labels stay legible
  // across the 6-orders-of-magnitude range of real reservoir capacities.
  const maxAbs = Math.max(0, ...data.map(([, v]) => (v == null ? 0 : Math.abs(v))));
  const useOku = maxAbs >= 100_000_000;
  const axisFormatter = useOku
    ? (v: number) => `${(v / 100_000_000).toFixed(1)}億`
    : (v: number) => `${(v / 10_000).toFixed(0)}万`;
  const tipFormatter = (
    params: Array<{ axisValueLabel: string; value: [string, number | null] }>,
  ) => {
    const p = params[0];
    if (!p) return '';
    const v = p.value[1];
    if (v == null) return `${p.axisValueLabel}<br/>—`;
    const txt =
      v >= 100_000_000
        ? `${(v / 100_000_000).toFixed(2)} 億 m³`
        : v >= 10_000
          ? `${Math.round(v / 10_000).toLocaleString('ja-JP')} 万 m³`
          : `${Math.round(v).toLocaleString('ja-JP')} m³`;
    return `${p.axisValueLabel}<br/>${txt}`;
  };
  const option = {
    grid: { left: 70, right: 20, top: 30, bottom: 40 },
    xAxis: { type: 'time' as const },
    yAxis: { type: 'value' as const, axisLabel: { formatter: axisFormatter } },
    tooltip: { trigger: 'axis' as const, formatter: tipFormatter },
    series: [
      {
        type: 'line' as const,
        data,
        smooth: true,
        sampling: 'lttb' as const,
        name: '貯水量',
      },
    ],
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
    </div>
  );
}
