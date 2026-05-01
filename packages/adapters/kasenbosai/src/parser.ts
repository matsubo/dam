// packages/adapters/kasenbosai/src/parser.ts
import { XMLParser } from 'fast-xml-parser';

export interface KasenbosaiReading {
  damId: string;
  observedAt: Date;
  storageVolumeM3: number | null;
  storageRate: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  waterLevelM: number | null;
  rainfallMm: number | null;
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

interface XmlReading {
  observedAt?: string;
  storageVolumeM3?: string | number;
  storageRate?: string | number;
  inflowM3s?: string | number;
  outflowM3s?: string | number;
  waterLevelM?: string | number;
  rainfallMm?: string | number;
}

interface XmlDam {
  '@_id'?: string;
  reading?: XmlReading | XmlReading[];
}

export function parseKasenbosaiReading(xml: string): KasenbosaiReading[] {
  const data = parser.parse(xml) as { damReadings?: { dam?: XmlDam | XmlDam[] } };
  const damsRaw = data.damReadings?.dam;
  if (!damsRaw) return [];
  const dams = Array.isArray(damsRaw) ? damsRaw : [damsRaw];
  const out: KasenbosaiReading[] = [];
  for (const d of dams) {
    const damId = d['@_id'];
    if (!damId) continue;
    const readingsRaw = d.reading;
    if (!readingsRaw) continue;
    const readings = Array.isArray(readingsRaw) ? readingsRaw : [readingsRaw];
    for (const r of readings) {
      if (!r.observedAt) continue;
      const observedAt = new Date(r.observedAt);
      if (Number.isNaN(observedAt.valueOf())) continue;
      out.push({
        damId,
        observedAt,
        storageVolumeM3: num(r.storageVolumeM3),
        storageRate: num(r.storageRate),
        inflowM3s: num(r.inflowM3s),
        outflowM3s: num(r.outflowM3s),
        waterLevelM: num(r.waterLevelM),
        rainfallMm: num(r.rainfallMm),
      });
    }
  }
  return out;
}
