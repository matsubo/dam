// packages/adapters/suimon/src/parser.ts
import Papa from 'papaparse';

export interface SuimonRow {
  observedAt: Date;
  storageVolumeM3: number | null;
  storageRate: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  waterLevelM: number | null;
  rainfallMm: number | null;
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parseSuimonCsv(csv: string): SuimonRow[] {
  const out: SuimonRow[] = [];
  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: true,
  });
  for (const r of parsed.data) {
    const ts = r.observed_at;
    if (!ts) continue;
    const observedAt = new Date(ts);
    if (Number.isNaN(observedAt.valueOf())) continue;
    out.push({
      observedAt,
      storageVolumeM3: num(r.storage_volume_m3),
      storageRate: num(r.storage_rate),
      inflowM3s: num(r.inflow_m3s),
      outflowM3s: num(r.outflow_m3s),
      waterLevelM: num(r.water_level_m),
      rainfallMm: num(r.rainfall_mm),
    });
  }
  return out;
}
