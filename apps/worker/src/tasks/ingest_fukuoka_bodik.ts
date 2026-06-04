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
// Storage conversion: 千m³ × 1000 → m³
// No water-level, inflow, outflow, or rainfall published.
//
// Cron: hourly at :35.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import type { Task } from 'graphile-worker';

const DATA_URL =
  process.env.FUKUOKA_BODIK_URL ??
  'https://data.bodik.jp/dataset/d54fb22e-5b64-485c-8816-69f27ed1aaf1/resource/a5b26052-26d1-4c7a-b63f-5736de453bc1/download';
const PREF_CODE = '40';
const SOURCE_ID = 'fukuoka-bodik';

export interface ParsedRow {
  damName: string;
  observedAt: Date;
  storageVolumeM3: number | null;
}

/** Parse "YYYY/MM/DD HH:MM" (JST) → UTC Date. */
export function parseFukuokaTimestamp(s: string): Date | null {
  const m = s.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  return new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5])),
  );
}

/** Strip ダム suffix and parenthetical annotations. */
export function normalizeName(s: string): string {
  return s
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/ダム$/, '')
    .trim();
}

/**
 * Parse the CSV text (already decoded to UTF-8) and return observations for
 * the most recent timestamp only.
 */
export function parseFukuokaRows(csvText: string): ParsedRow[] {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map((h) => h.trim());
  const tsIdx = 0;
  const totalIdx = headers.indexOf('合計');

  const dataLine = lines[1];
  if (!dataLine) return [];

  const cols = dataLine.split(',');
  const observedAt = parseFukuokaTimestamp(cols[tsIdx]?.trim() ?? '');
  if (!observedAt) return [];

  const out: ParsedRow[] = [];
  for (let i = 1; i < headers.length; i++) {
    if (i === totalIdx) continue;
    const name = headers[i];
    if (!name || name === '合計') continue;
    const raw = Number(cols[i]?.trim());
    const storageThouM3 = Number.isFinite(raw) && raw >= 0 ? raw : null;
    out.push({
      damName: name,
      observedAt,
      storageVolumeM3: storageThouM3 != null ? storageThouM3 * 1000 : null,
    });
  }
  return out;
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 310,
            '福岡市関連9ダム — BODIK CC-BY, hourly CSV (Shift-JIS, 千m³)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

interface DamMatch {
  damName: string;
  damId: bigint;
}

export function chooseMaster(stem: string, masters: { id: bigint; name: string }[]): bigint | null {
  let best: { id: bigint; rank: number } | null = null;
  for (const m of masters) {
    const mStem = normalizeName(m.name);
    let rank: number;
    if (mStem === stem) rank = 0;
    else if (m.name === `${stem}ダム`) rank = 1;
    else if (mStem.startsWith(stem)) rank = 2;
    else if (mStem.includes(stem)) rank = 3;
    else continue;
    if (!best || rank < best.rank || (rank === best.rank && m.id < best.id)) {
      best = { id: m.id, rank };
    }
  }
  return best?.id ?? null;
}

async function matchMaster(rows: ParsedRow[], log: (s: string) => void): Promise<DamMatch[]> {
  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];
  for (const r of rows) {
    const stem = normalizeName(r.damName);
    if (!stem) continue;
    const damId = chooseMaster(stem, masters);
    if (!damId) {
      log(`${SOURCE_ID}: no master match for ${r.damName}`);
      continue;
    }
    out.push({ damName: r.damName, damId });
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object(${SOURCE_ID}::text, ${r.damName}::text)
      WHERE id = ${damId}
        AND COALESCE(external_ids->>${SOURCE_ID}, '') <> ${r.damName}
    `;
  }
  return out;
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const ua =
    process.env.HTTP_USER_AGENT ??
    'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

  const res = await fetch(DATA_URL, {
    headers: { 'user-agent': ua },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    log(`${SOURCE_ID}: HTTP ${res.status}; abort`);
    return;
  }

  const buf = await res.arrayBuffer();
  const csvText = new TextDecoder('shift-jis').decode(buf);
  const parsed = parseFukuokaRows(csvText);
  log(
    `${SOURCE_ID}: parsed ${parsed.length} dams at ${parsed[0]?.observedAt?.toISOString() ?? 'unknown'}`,
  );
  if (!parsed.length) return;

  const matches = await matchMaster(parsed, log);
  const damByName = new Map(matches.map((m) => [m.damName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of parsed) {
    const damId = damByName.get(p.damName);
    if (!damId) continue;
    inputs.push({
      observedAt: p.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: p.storageVolumeM3,
      storageRate: null,
      inflowM3s: null,
      outflowM3s: null,
      waterLevelM: null,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }
  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: parsed=${parsed.length} matched=${matches.length} written=${written}`);
};

export default task;
