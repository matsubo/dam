'use client';

import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';

type LeafletMap = { remove: () => void };

// Single-marker Leaflet map for the dam-detail page. Same React 19
// StrictMode-safe lifecycle pattern as JapanMap (cancelled flag + cleanup),
// same GSI tile basemap (grayscaled via the .jp-map-grayscale class).
export function DamLocationMap({
  lat,
  lng,
  name,
  zoom = 13,
}: {
  lat: number;
  lng: number;
  name: string;
  zoom?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let map: LeafletMap | null = null;

    void import('leaflet').then((Lmod) => {
      if (cancelled || !ref.current) return;
      const L = Lmod.default ?? Lmod;
      const instance = L.map(ref.current, { zoomControl: true, scrollWheelZoom: false }).setView(
        [lat, lng],
        zoom,
      );
      map = instance;
      L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', {
        attribution:
          '&copy; <a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>',
        maxZoom: 18,
        className: 'jp-map-grayscale',
      }).addTo(instance);

      L.circleMarker([lat, lng], {
        radius: 9,
        color: '#0057c0',
        weight: 2,
        fillColor: '#1e6dff',
        fillOpacity: 0.85,
      })
        .bindPopup(`<b>${name}</b>`)
        .addTo(instance);
    });

    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [lat, lng, name, zoom]);

  return (
    <div
      ref={ref}
      style={{ height: 320 }}
      className="rounded-xl overflow-hidden border border-outline-variant"
    />
  );
}
