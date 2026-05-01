export interface ParsedWatershed {
  code: string;
  name: string;
  nameKana?: string | null;
  kind: 'first' | 'second' | 'other';
  geometry: GeoJSON.MultiPolygon | GeoJSON.Polygon;
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
