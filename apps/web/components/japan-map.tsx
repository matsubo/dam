'use client';

import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';

export interface MapPoint {
  slug: string;
  name: string;
  lat: number;
  lng: number;
  capacityM3?: number | null;
  storageRate?: number | null;
}

type LeafletMap = { remove: () => void };

// Map storage rate (0..1) to a colour on a blue → green → yellow ramp.
// Same anchors as a typical sequential viridis-like palette so low/full
// reservoirs are visually distinct.
function rateColor(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return '#9ca3af'; // gray-400 — no data
  if (rate < 0.25) return '#1e6dff'; // low — blue
  if (rate < 0.5) return '#06a8c2'; // teal
  if (rate < 0.75) return '#16a34a'; // green
  if (rate < 0.9) return '#eab308'; // yellow
  return '#f97316'; // near-full — orange
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
        const capTxt = p.capacityM3
          ? p.capacityM3 >= 1e8
            ? `${(p.capacityM3 / 1e8).toFixed(2)} 億 m³`
            : `${Math.round(p.capacityM3 / 1e4).toLocaleString('ja-JP')} 万 m³`
          : '—';
        L.circleMarker([p.lat, p.lng], {
          radius: r,
          color,
          weight: 1,
          fillColor: color,
          fillOpacity: 0.7,
        })
          .bindPopup(
            `<a href="/dams/${p.slug}"><b>${p.name}</b></a><br/>` +
              `総貯水容量: ${capTxt}<br/>貯水率: ${ratePct}`,
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
