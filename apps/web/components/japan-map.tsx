'use client';

import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';

export interface MapPoint {
  slug: string;
  name: string;
  lat: number;
  lng: number;
}

export function JapanMap({ points }: { points: MapPoint[] }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    void import('leaflet').then((Lmod) => {
      const L = Lmod.default ?? Lmod;
      if (!ref.current) return;
      const map = L.map(ref.current).setView([36.5, 138.5], 5);
      L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', {
        attribution:
          '&copy; <a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>',
        maxZoom: 18,
      }).addTo(map);

      // Cluster: simple decimation. Replace with leaflet.markercluster if needed.
      const layer = L.layerGroup().addTo(map);
      for (const p of points) {
        L.circleMarker([p.lat, p.lng], {
          radius: 4,
          color: '#1e6dff',
          weight: 1,
          fillOpacity: 0.7,
        })
          .bindPopup(`<a href="/dams/${p.slug}">${p.name}</a>`)
          .addTo(layer);
      }
      cleanup = () => map.remove();
    });
    return () => cleanup?.();
  }, [points]);

  return <div ref={ref} style={{ height: 'calc(100vh - 200px)', minHeight: 480 }} />;
}
