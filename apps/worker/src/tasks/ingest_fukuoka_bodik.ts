// apps/worker/src/tasks/ingest_fukuoka_bodik.ts
//
// 福岡市関連ダム諸量 — BODIK open data (CC-BY 4.0).
//
// Source: https://data.bodik.jp/dataset/401307_mizukanri
// Single CSV resource (Shift-JIS), updated hourly.
// The file is the current month's hourly records, newest row first.
//
// 9 dams: 南畑/五ケ山/脊振/曲渕/江川/久原/長谷/猪野/瑞梅寺
// All are water-supply dams managed by 福岡市水道局 (Fukuoka city waterworks).
//
// Columns:
//   観測時刻  → timestamp, "YYYY/MM/DD HH:MM" JST
//   [dam names 1-9] → effective storage in 千m³ (confirmed: unit matches
//                      known capacities at plausible fill rates)
//   合計  → sum column, skipped
//
// The header row is the universe: a dam column whose newest cell is blank or
// unparseable is unreadable, and so is every dam when the file has no
// parseable data row.
//
// Storage conversion: 千m³ × 1000 → m³
// No water-level, inflow, outflow, or rainfall published.
//
// Cron: hourly at :35.

import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const DATA_URL =
  process.env.FUKUOKA_BODIK_URL ??
  'https://data.bodik.jp/dataset/d54fb22e-5b64-485c-8816-69f27ed1aaf1/resource/a5b26052-26d1-4c7a-b63f-5736de453bc1/download';
const PREF_CODE = '40';
const SOURCE_ID = 'fukuoka-bodik';

/** Parse "YYYY/MM/DD HH:MM" (JST) → UTC Date. */
export function parseFukuokaTimestamp(s: string): Date | null {
  const m = s.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  return new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5])),
  );
}

/**
 * Parse the CSV text (already decoded to UTF-8): one entry per dam column,
 * read from the most recent row (top of file).
 */
export function fukuokaEntries(csvText: string): Entry[] {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const headerLine = lines[0];
  if (!headerLine) return [];
  const headers = headerLine.split(',').map((h) => h.trim());

  const cols = (lines[1] ?? '').split(',');
  const stamp = cols[0]?.trim() ?? '';
  const observedAt = parseFukuokaTimestamp(stamp);

  const out: Entry[] = [];
  for (let i = 1; i < headers.length; i++) {
    const name = headers[i];
    if (!name || name === '合計') continue;
    const cellText = cols[i]?.trim() ?? '';
    const raw = cellText ? Number(cellText) : Number.NaN;
    let reading: Reading;
    if (!observedAt) reading = { state: 'unreadable', why: `観測時刻 "${stamp}"` };
    else if (!Number.isFinite(raw) || raw < 0) {
      reading = { state: 'unreadable', why: `貯水量 "${cellText}"` };
    } else {
      // 千m³ → m³
      reading = { state: 'values', observations: [{ observedAt, storageVolumeM3: raw * 1000 }] };
    }
    // The master spells 五ヶ山 with a small ヶ (U+30F6); the CSV header sends
    // the full-size ケ (U+30B1). NFKC keeps them apart, so the ladder searches
    // with the master's spelling.
    const spelled = name.replace(/ケ/g, 'ヶ');
    out.push({
      key: name,
      name,
      pref: PREF_CODE,
      ...(spelled !== name ? { bind: { name: spelled } } : {}),
      reading,
    });
  }
  return out;
}

export default ingestTask(SOURCE_ID, async (log) => {
  const res = await fetch(DATA_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${SOURCE_ID}: HTTP ${res.status}`);
  const csvText = new TextDecoder('shift-jis').decode(await res.arrayBuffer());
  const entries = fukuokaEntries(csvText);
  log(`${SOURCE_ID}: ${entries.length} dams`);
  return { entries };
});
