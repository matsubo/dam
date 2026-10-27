// apps/worker/src/tasks/ingest_tochigi.ts
//
// Phase B6 (#10, BODIK batch): 栃木県 ダム諸量 — official BODIK open-data
// CSV in NGSI-v2 shape. CC-BY 4.0, refreshed every 10 minutes.
//
// Source: data.bodik.jp dataset 090000_river_dam_parameter, resource
// `tochigi_dampref.csv`. Columns (RFC-4180 quoted, the `location` field
// embeds a JSON object with "" escapes):
//
//   id,type,address,dateObserved,inflow,location,officeName,officeNumber,
//   outflow,pointName,pointNumber,riverName,riverSystemName,
//   waterLevel,waterStorage
//
// dateObserved is already an ISO-8601 UTC timestamp. waterStorage is in
// 千m³ — multiply by 1000 for m³. Seven prefectural dams in this feed
// (寺山/塩原/西荒川/東荒川/三河沢/中禅寺/松田川). Cron hourly at :27.

import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const CSV_URL =
  process.env.TOCHIGI_DAM_CSV ??
  'https://data.bodik.jp/dataset/a66bea6a-bb25-404f-a16d-dc839c75e007/resource/2e94dd9c-7157-498b-88c7-cbc0c85c6297/download/tochigi_dampref.csv';
const PREF_CODE = '09';
const SOURCE_ID = 'tochigi-bodik';

/**
 * Minimal RFC-4180 CSV-line splitter: handles double-quoted fields with
 * embedded commas and the `""` escape for a literal `"`. Newlines are
 * assumed to delimit records (the feed never embeds them inside fields).
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  let cur = '';
  let inQuote = false;
  while (i < line.length) {
    const c = line[i] ?? '';
    if (inQuote) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        inQuote = false;
        i += 1;
        continue;
      }
      cur += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuote = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      out.push(cur);
      cur = '';
      i += 1;
      continue;
    }
    cur += c;
    i += 1;
  }
  out.push(cur);
  return out;
}

function parseNum(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** The feed carries no per-field flag: a row with no number is unreadable. */
function rowReading(c: string[]): Reading {
  const stampStr = (c[3] ?? '').trim();
  const observedAt = new Date(stampStr);
  if (!stampStr || Number.isNaN(observedAt.valueOf())) {
    return { state: 'unreadable', why: `dateObserved "${stampStr}"` };
  }
  const volThou = parseNum(c[14] ?? '');
  return {
    state: 'values',
    observations: [
      {
        observedAt,
        waterLevelM: parseNum(c[13] ?? ''),
        storageVolumeM3: volThou != null ? volThou * 1_000 : null,
        inflowM3s: parseNum(c[4] ?? ''),
        outflowM3s: parseNum(c[8] ?? ''),
      },
    ],
  };
}

/**
 * Parse the NGSI-v2 dam CSV: one entry per dam row, keyed by pointName (the
 * stamp this source has always used). Skips the header and nameless rows.
 */
export function tochigiEntries(csv: string): Entry[] {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/);
  const out: Entry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const c = splitCsvLine(line);
    if (c.length < 15) continue;
    if (c[0] === 'id') continue; // header
    const name = (c[9] ?? '').trim();
    if (!name) continue;
    out.push({ key: name, name, pref: PREF_CODE, reading: rowReading(c) });
  }
  return out;
}

export default ingestTask(SOURCE_ID, async ({ log, upstream }) => {
  const res = await upstream.fetch(CSV_URL, { timeoutMs: 15_000 });
  const entries = tochigiEntries(res.text());
  log(`${SOURCE_ID}: ${entries.length} dams`);
  return { entries };
});
