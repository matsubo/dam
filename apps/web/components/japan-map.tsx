'use client';

import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';

export interface MapPoint {
  slug: string;
  name: string;
  lat: number;
  lng: number;
  capacityM3?: number | null;
  /** 利水容量 — the 貯水率 denominator. */
  activeCapacityM3?: number | null;
  storageRate?: number | null;
}

type LeafletMap = { remove: () => void };

// Map storage rate (0..1) to a colour on a continuous red → blue gradient.
// 0% → red (hue 0), 100% → blue (hue 220). Linear in HSL hue so the ramp
// passes naturally through orange / yellow / green / cyan on the way up.
function rateColor(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return '#9ca3af'; // gray-400 — no data
  const t = Math.max(0, Math.min(1, rate));
  const hue = Math.round(t * 220); // 0 (red) → 220 (blue)
  return `hsl(${hue}, 78%, 48%)`;
}

// "1.23 億 m³" / "45 万 m³" / "—" — shared by the capacity + active-capacity
// popup lines.
function fmtManM3(m3: number | null | undefined): string {
  if (!m3) return '—';
  return m3 >= 1e8
    ? `${(m3 / 1e8).toFixed(2)} 億 m³`
    : `${Math.round(m3 / 1e4).toLocaleString('ja-JP')} 万 m³`;
}

// Marker radius in pixels mapped from capacity. Use sqrt so circle AREA is
// proportional to capacity (area ∝ r²).
function radiusForCapacity(capacityM3: number | null | undefined): number {
  if (!capacityM3 || capacityM3 <= 0) return 3;
  // sqrt(volume / 1e7) gives a clean range across 5 orders of magnitude:
  //   1e6 m³ (1万 m³)  → ~0.3 px
  //   1e7 m³           → 1 px
  //   1e8 m³           → ~3.2 px
  //   1e9 m³           → ~10 px
  // Floor at 3 (small dams stay visible) and cap at 24 (very large dams).
  return Math.max(3, Math.min(24, Math.sqrt(capacityM3 / 1e7) * 3));
}

export function JapanMap({ points }: { points: MapPoint[] }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let map: LeafletMap | null = null;

    void import('leaflet').then((Lmod) => {
      if (cancelled || !ref.current) return;
      const L = Lmod.default ?? Lmod;
      const instance = L.map(ref.current).setView([36.5, 138.5], 5);
      map = instance;
      L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', {
        attribution:
          '&copy; <a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>',
        maxZoom: 18,
        // Inline class so a CSS filter can desaturate just the basemap tiles.
        // Markers stay full colour (they're in a different Leaflet pane).
        className: 'jp-map-grayscale',
      }).addTo(instance);

      const layer = L.layerGroup().addTo(instance);
      for (const p of points) {
        const color = rateColor(p.storageRate);
        const r = radiusForCapacity(p.capacityM3);
        const ratePct =
          p.storageRate != null && Number.isFinite(p.storageRate)
            ? `${(p.storageRate * 100).toFixed(1)}%`
            : '—';
        const capTxt = fmtManM3(p.capacityM3);
        const activeCapTxt = fmtManM3(p.activeCapacityM3);
        L.circleMarker([p.lat, p.lng], {
          radius: r,
          color,
          weight: 1,
          fillColor: color,
          fillOpacity: 0.7,
        })
          .bindPopup(
            `<a href="/dams/${p.slug}"><b>${p.name}</b></a><br/>` +
              `総貯水容量: ${capTxt}<br/>利水容量: ${activeCapTxt}<br/>貯水率: ${ratePct}`,
          )
          .addTo(layer);
      }
    });

    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [points]);

  return <div ref={ref} style={{ height: 'calc(100vh - 200px)', minHeight: 480 }} />;
}
