// apps/worker/src/tasks/ingest_kumamoto_bousai.ts
//
// 熊本県防災情報システム 地方別ダム情報 — 6 ダム, 60分更新.
//
//   6 dams: 市房/氷川/石打/上津浦/亀川/路木
//
// Source:
//   https://www.bousai.pref.kumamoto.jp/Dsp/GmnDspD.exe?52A0
// Format: Shift_JIS JS page; DspDat[] array, 12 comma-separated fields per dam.
//   Fields: name(HTML) / river / datetime(YYYY/MM/DD HH:MM JST) / 貯水位(m) /
//           全流入量(m³/s) / 全放流量(m³/s) / 有効貯水量(10³m³) / 利水量(10³m³) /
//           治水量(10³m³) / 貯水率(有効容量)(%) / 貯水率(利水容量)(%) / 貯水率(治水容量)(%)
// We store: waterLevelM, inflowM3s, outflowM3s, 有効貯水量×1000→m³, 貯水率(利水容量).
// storageRate prefers 貯水率(利水容量) over 貯水率(有効容量) so it matches this
// site's own 貯水率 definition (storage_volume_m3/active_capacity_m3, 利水容量);
// both rate columns share the same numerator (有効貯水量) so pairing either
// with storageVolumeM3 stays dimensionally consistent. See issue #17 — some
// of these dams' 有効容量-based and 利水容量-based rates diverge sharply
// (e.g. 氷川ダム: 22% vs 94%), the same static-vs-seasonal-capacity mismatch
// found for 八田原ダム.
// DspDat carries no station code, so the printed name is the key. An entry
// whose time or fields cannot be read is still listed, unreadable.
// Priority 308.

import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const DATA_URL =
  process.env.KUMAMOTO_BOUSAI_URL ?? 'https://www.bousai.pref.kumamoto.jp/Dsp/GmnDspD.exe?52A0';

const PREF_CODE = '43';
const SOURCE_ID = 'kumamoto-bousai';

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  kumamotoName: string;
  observedAt: Date;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  storageVolumeM3: number | null;
  storageRate: number | null;
}

// --- parsing ----------------------------------------------------------------

/** "YYYY/MM/DD HH:MM" JST → UTC Date */
export function parseKumamotoDatetime(s: string): Date | null {
  const m = s.trim().match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0, 0),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseNum(s: string): number | null {
  const clean = s.replace(/[^\d.-]/g, '').trim();
  if (!clean) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse one DspDat entry value (the string inside the single quotes).
 *
 * The value is a comma-separated list of 12 HTML-encoded fields:
 *   [0] <a href="..."><u>DAM_NAME</u></a>
 *   [1] river name
 *   [2] YYYY/MM/DD HH:MM (JST)
 *   [3] 貯水位 (m)
 *   [4] 全流入量 (m³/s)
 *   [5] 全放流量 (m³/s)
 *   [6] 有効貯水量 (10³m³)
 *   [7] 利水量 (10³m³)
 *   [8] 治水量 (10³m³)
 *   [9] 貯水率(有効容量) (%)
 *  [10] 貯水率(利水容量) (%)
 *  [11] 貯水率(治水容量) (%)
 */
export function parseDspDatEntry(raw: string): ParsedRow | null {
  const kumamotoName = damNameOf(raw);
  if (!kumamotoName) return null;

  // Strip all HTML tags; arrow chars (↑↓→) get stripped by parseNum
  const stripped = raw.replace(/<[^>]+>/g, '');
  const fields = stripped.split(',');
  if (fields.length < 10) return null;

  const observedAt = parseKumamotoDatetime(fields[2] ?? '');
  if (!observedAt) return null;

  const effectiveKm3 = parseNum(fields[6] ?? '');

  return {
    kumamotoName,
    observedAt,
    waterLevelM: parseNum(fields[3] ?? ''),
    inflowM3s: parseNum(fields[4] ?? ''),
    outflowM3s: parseNum(fields[5] ?? ''),
    storageVolumeM3: effectiveKm3 !== null ? effectiveKm3 * 1_000 : null,
    storageRate: (() => {
      const r = parseNum(fields[10] ?? '') ?? parseNum(fields[9] ?? '');
      return r !== null ? r / 100 : null;
    })(),
  };
}

/** The dam name in an entry's HTML link, before any tag is stripped. */
function damNameOf(raw: string): string {
  return raw.match(/<u>([^<]+)<\/u>/i)?.[1]?.trim() ?? '';
}

/** A row with any value has values; the page prints no 欠測 mark. */
function kumamotoReading(p: ParsedRow): Reading {
  if (
    p.waterLevelM === null &&
    p.inflowM3s === null &&
    p.outflowM3s === null &&
    p.storageVolumeM3 === null &&
    p.storageRate === null
  ) {
    return { state: 'unreadable', why: 'no value' };
  }
  return {
    state: 'values',
    observations: [
      {
        observedAt: p.observedAt,
        waterLevelM: p.waterLevelM,
        inflowM3s: p.inflowM3s,
        outflowM3s: p.outflowM3s,
        storageVolumeM3: p.storageVolumeM3,
        storageRate: p.storageRate,
      },
    ],
  };
}

/**
 * Every DspDat entry of the JS page source. One without a name has nothing to
 * key it by; one whose time or fields cannot be read is unreadable.
 */
export function kumamotoEntries(html: string): Entry[] {
  return [...html.matchAll(/DspDat\[\d+\]\s*=\s*'([^']+)'/g)].flatMap((m) => {
    const raw = m[1] ?? '';
    const name = damNameOf(raw);
    if (!name) return [];
    const row = parseDspDatEntry(raw);
    const reading: Reading = row
      ? kumamotoReading(row)
      : { state: 'unreadable', why: 'DspDat entry without a time or its 12 fields' };
    return [{ key: name, name, pref: PREF_CODE, reading }];
  });
}

// --- task -------------------------------------------------------------------

export default ingestTask(SOURCE_ID, async ({ log, upstream }) => {
  const html = (await upstream.fetch(DATA_URL)).text('shift_jis');
  const entries = kumamotoEntries(html);
  log(`${SOURCE_ID}: parsed ${entries.length} dam rows`);
  return { entries };
});
