'use client';

import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';

export interface MapPoint {
  slug: string;
  name: string;
  lat: number;
  lng: number;
}

type LeafletMap = { remove: () => void };

export function JapanMap({ points }: { points: MapPoint[] }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Guard against React 19 StrictMode double-invocation: the cleanup runs
    // synchronously between the two mounts, but `import('leaflet')` resolves
    // asynchronously. Without a flag, both effect runs would race to call
    // `L.map(ref.current)` on the same div → "Map container is already
    // initialized."
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
      }).addTo(instance);

      const layer = L.layerGroup().addTo(instance);
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
    });

    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [points]);

  return <div ref={ref} style={{ height: 'calc(100vh - 200px)', minHeight: 480 }} />;
}
