export interface DamnetListItem {
  damnetId: string;
  name: string;
  prefCode: string;
  detailUrl: string;
}

export interface DamnetDetail {
  damnetId: string;
  name: string;
  nameKana?: string | null;
  prefCode: string;
  manager?: string | null;
  type?: string | null;
  heightM?: number | null;
  totalCapacityM3?: number | null;
  effectiveCapacityM3?: number | null;
  floodCapacityM3?: number | null;
  completedYear?: number | null;
  lat?: number | null;
  lng?: number | null;
}
