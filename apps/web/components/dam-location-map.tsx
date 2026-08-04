'use client';

import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'react';

type LeafletMap = {
  remove: () => void;
  removeLayer: (l: unknown) => void;
};
type LeafletTileLayer = unknown;

interface MapStyle {
  id: string;
  label: string;
  url: string;
  attribution: string;
  maxZoom: number;
  className?: string;
}

// Available basemaps. All from public-domain or government sources.
// `gsi-pale` is the muted style used originally; the new options give the
// user a colour, satellite (with road labels), and OSM-standard alternative.
const STYLES: MapStyle[] = [
  {
    id: 'gsi-pale',
    label: '淡色 (国土地理院)',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>',
    maxZoom: 18,
    className: 'jp-map-grayscale',
  },
  {
    id: 'gsi-std',
    label: 'カラー (国土地理院)',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>',
    maxZoom: 18,
  },
  {
    id: 'gsi-photo',
    label: '衛星写真 (国土地理院)',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
    attribution:
      '&copy; <a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院 シームレス空中写真</a>',
    maxZoom: 18,
  },
  {
    id: 'gsi-relief',
    label: '地形 (国土地理院)',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/relief/{z}/{x}/{y}.png',
    attribution:
      '&copy; <a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院 色別標高図</a>',
    maxZoom: 15,
  },
  {
    id: 'osm',
    label: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  },
];

const DEFAULT_STYLE_ID = 'gsi-pale';
const STORAGE_KEY = 'damLocationMapStyle';
// biome-ignore lint/style/noNonNullAssertion: STYLES is a non-empty literal
const FALLBACK_STYLE = STYLES[0]!;

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
  const mapRef = useRef<LeafletMap | null>(null);
  const tileRef = useRef<LeafletTileLayer | null>(null);
  // L is captured once the dynamic import resolves so the style switch can
  // swap tile layers without re-importing leaflet on every change.
  const leafletRef = useRef<typeof import('leaflet') | null>(null);

  // Persist the selected style across visits so users don't have to re-pick.
  // Falls back to the original muted basemap on first load / SSR.
  const [styleId, setStyleId] = useState<string>(DEFAULT_STYLE_ID);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved && STYLES.some((s) => s.id === saved)) setStyleId(saved);
  }, []);

  // Intentionally omit `styleId` here — the dedicated style-swap effect
  // below changes the tile layer in place without rebuilding the map.
  // biome-ignore lint/correctness/useExhaustiveDependencies: styleId is read via the style-swap effect below, not rebuilt here
  useEffect(() => {
    let cancelled = false;

    void import('leaflet').then((Lmod) => {
      if (cancelled || !ref.current) return;
      const L = (Lmod.default ?? Lmod) as typeof import('leaflet');
      leafletRef.current = L;
      const instance = L.map(ref.current, { zoomControl: true, scrollWheelZoom: false }).setView(
        [lat, lng],
        zoom,
      );
      mapRef.current = instance as unknown as LeafletMap;

      const initial = STYLES.find((s) => s.id === styleId) ?? FALLBACK_STYLE;
      tileRef.current = L.tileLayer(initial.url, {
        attribution: initial.attribution,
        maxZoom: initial.maxZoom,
        className: initial.className,
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
      mapRef.current?.remove();
      mapRef.current = null;
      tileRef.current = null;
      leafletRef.current = null;
    };
  }, [lat, lng, name, zoom]);

  // Hot-swap the tile layer when the user picks a different style.
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map) return;
    const next = STYLES.find((s) => s.id === styleId) ?? FALLBACK_STYLE;
    const newTile = L.tileLayer(next.url, {
      attribution: next.attribution,
      maxZoom: next.maxZoom,
      className: next.className,
    });
    if (tileRef.current) {
      map.removeLayer(tileRef.current);
    }
    // biome-ignore lint/suspicious/noExplicitAny: leaflet types lack a precise interface here
    newTile.addTo(map as any);
    tileRef.current = newTile;
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, styleId);
    }
  }, [styleId]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <span className="text-on-surface-variant mr-1">スタイル:</span>
        {STYLES.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setStyleId(s.id)}
            aria-pressed={s.id === styleId}
            className={`px-2.5 py-1 rounded-full border transition-colors ${
              s.id === styleId
                ? 'bg-primary text-white border-primary'
                : 'bg-white text-on-surface-variant border-outline-variant hover:bg-surface-container-low'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div
        ref={ref}
        style={{ height: 320 }}
        className="rounded-xl overflow-hidden border border-outline-variant"
      />
    </div>
  );
}
