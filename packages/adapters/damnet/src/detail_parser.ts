import * as cheerio from 'cheerio';
import { prefNameToCode } from './list_scraper.ts';
import type { DamnetDetail } from './types.ts';

function num(text: string | undefined): number | null {
  if (!text) return null;
  const cleaned = text.replace(/[, m³年度]/g, '').trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function intish(text: string | undefined): number | null {
  const n = num(text);
  return n === null ? null : Math.trunc(n);
}

function parseLatLng(text: string | undefined): { lat: number | null; lng: number | null } {
  if (!text) return { lat: null, lng: null };
  const m = text.match(/北緯\s*([\d.]+)\s*度.*東経\s*([\d.]+)\s*度/);
  if (!m) return { lat: null, lng: null };
  return { lat: Number(m[1]), lng: Number(m[2]) };
}

export function parseDamnetDetail(html: string, damnetId: string): DamnetDetail {
  const $ = cheerio.load(html);
  const fields: Record<string, string> = {};
  $('table.dam-attr tr').each((_, row) => {
    const th = $(row).find('th').text().trim();
    const td = $(row).find('td').text().trim();
    if (th) fields[th] = td;
  });

  const prefName = fields['都道府県'];
  if (!prefName) throw new Error(`damnet detail missing pref for ${damnetId}`);
  const name = fields['ダム名'];
  if (!name) throw new Error(`damnet detail missing name for ${damnetId}`);

  const { lat, lng } = parseLatLng(fields['位置']);

  return {
    damnetId,
    name,
    nameKana: fields['ふりがな'] ?? null,
    prefCode: prefNameToCode(prefName),
    manager: fields['管理者'] ?? null,
    type: fields['型式'] ?? null,
    heightM: num(fields['堤高']),
    totalCapacityM3: num(fields['総貯水容量']),
    effectiveCapacityM3: num(fields['有効貯水容量']),
    floodCapacityM3: num(fields['洪水調節容量']),
    completedYear: intish(fields['竣工']),
    lat,
    lng,
  };
}
