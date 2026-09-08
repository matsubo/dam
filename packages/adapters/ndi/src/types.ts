import type { MultiPolygon, Polygon } from 'geojson';

export interface ParsedWatershed {
  code: string;
  /** 国土数値情報 水系域コード (6 桁) when the source carries one. */
  ndiCode?: string | null;
  name: string;
  nameKana?: string | null;
  kind: 'first' | 'second' | 'other';
  geometry: MultiPolygon | Polygon;
  areaKm2?: number | null;
}

export interface ParsedDam {
  ndiId: string; // unique within NLNI
  name: string;
  prefCode: string;
  manager?: string | null;
  type?: string | null;
  heightM?: number | null;
  totalCapacityM3?: number | null;
  effectiveCapacityM3?: number | null;
  floodCapacityM3?: number | null;
  completedYear?: number | null;
  lat: number;
  lng: number;
  watershedCode?: string | null;
}
