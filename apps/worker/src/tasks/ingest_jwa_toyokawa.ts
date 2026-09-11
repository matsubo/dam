// apps/worker/src/tasks/ingest_jwa_toyokawa.ts
//
// 水資源機構 中部支社 豊川水系 — 宇連ダム / 大島ダム.
// Real-time page updated every ~10 minutes; fetched hourly.
//
//   豊川水系: 宇連 (愛知) / 大島 (愛知)
//
// Source: https://www.water.go.jp/mizu/chubu/realtime/index_2.html
// Format: Static HTML with tabular blocks; "観測時刻：YYYY年MM月DD日 HH時MM分" (JST).
//         Storage in m³ (有効貯水量); water level in EL.m.
//         "cc" = sensor communication cut; treat as null.
// License: 水資源機構 published; 出典明示で再配布可.
//
// These two dams are in jwa-junpo (10-day) and aitoyo (daily). This adapter
// upgrades them to real-time cadence and adds 水位 (EL.m) not available from
// jwa-junpo/aitoyo. Priority 298 > aitoyo 295 so this becomes preferredSource.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const PAGE_URL =
  process.env.JWA_TOYOKAWA_URL ?? 'https://www.water.go.jp/mizu/chubu/realtime/index_2.html';

const NAME_MAP: Array<{ toyoName: string; masterName: string; prefCodes: string[] }> = [
  { toyoName: '宇連ダム', masterName: '宇連', prefCodes: ['23'] }, // 愛知
  { toyoName: '大島ダム', masterName: '大島', prefCodes: ['23'] },
];

interface ParsedRow {
  toyoName: string;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

function textOf(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/　/g, ' ')
    .trim();
}

function parseNum(s: string): number | null {
  const cleaned = s.replace(/[,\s　]/g, '');
  if (!cleaned || cleaned === '―' || cleaned === '-' || cleaned === '—' || cleaned === 'cc') {
    return null;
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse "観測時刻：YYYY年MM月DD日 HH時MM分" → UTC Date.
 * The page timestamp is JST; subtract 9 hours to get UTC.
 */
export function parseTokyokawaTimestamp(text: string): Date | null {
  const m = text.match(/(\d{4})年(\d{2})月(\d{2})日\s+(\d{1,2})時(\d{2})分/);
  if (!m) return null;
  const yr = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  const hr = Number(m[4]);
  const mi = Number(m[5]);
  // JST = UTC+9; Date.UTC handles out-of-range hours via normalization.
  const d = new Date(Date.UTC(yr, mo - 1, day, hr - 9, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Extract section of HTML from damName to the next known dam name.
 * Used to isolate each dam's data block from the rest of the page.
 */
function extractSection(html: string, damName: string, allNames: string[]): string {
  const start = html.indexOf(damName);
  if (start < 0) return '';
  let end = html.length;
  for (const other of allNames) {
    if (other === damName) continue;
    const idx = html.indexOf(other, start + damName.length);
    if (idx > start && idx < end) end = idx;
  }
  return html.slice(start, end);
}

function extractLabeled(section: string, label: string): number | null {
  const labelIdx = section.indexOf(label);
  if (labelIdx < 0) return null;
  const context = textOf(section.slice(labelIdx, labelIdx + 300));
  // Skip the label text itself, then find the first number.
  const afterLabel = context.slice(label.length);
  const m = afterLabel.match(/([\d,]+(?:\.\d+)?)/);
  if (!m) return null;
  return parseNum(m[1] ?? '');
}

export function parseToyokawaHtml(html: string): {
  observedAt: Date | null;
  rows: ParsedRow[];
} {
  const observedAt = parseTokyokawaTimestamp(html);
  const rows: ParsedRow[] = [];
  const allNames = NAME_MAP.map((m) => m.toyoName);

  for (const m of NAME_MAP) {
    const section = extractSection(html, m.toyoName, allNames);
    if (!section) continue;

    // Extract each labeled field; "cc" values produce null via parseNum.
    const waterLevel = extractLabeled(section, '貯水位');
    const storage = extractLabeled(section, '有効貯水量');
    const inflow = extractLabeled(section, '流入量');
    const outflow = extractLabeled(section, '放流量');

    // Skip if both primary metrics are unavailable (full cc outage).
    if (waterLevel == null && storage == null) continue;

    rows.push({
      toyoName: m.toyoName,
      waterLevelM: waterLevel,
      storageVolumeM3: storage,
      inflowM3s: inflow,
      outflowM3s: outflow,
    });
  }
  return { observedAt, rows };
}

interface DamMatch {
  toyoName: string;
  damId: bigint;
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES ('jwa-toyokawa', 298,
            '水資源機構 中部支社 豊川水系 — real-time (~10 min), 2 dams (宇連/大島)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

async function ensureExternalIds(log: (s: string) => void): Promise<DamMatch[]> {
  const matches: DamMatch[] = [];
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];
  for (const m of NAME_MAP) {
    const rows = await sql<{ id: bigint; name: string }[]>`
      SELECT id, name FROM dams
      WHERE pref_code = ANY(${m.prefCodes}::text[])
        AND name LIKE ${`%${m.masterName}%`}
      ORDER BY
        CASE
          WHEN name = ${`${m.masterName}ダム`}       THEN 0
          WHEN name = ${m.masterName}                 THEN 1
          WHEN name LIKE ${`${m.masterName}（再）%`}  THEN 2
          ELSE 5
        END,
        id
      LIMIT 1
    `;
    const r = rows[0];
    universe.push({
      externalId: m.toyoName,
      name: m.toyoName,
      prefCode: m.prefCodes[0] ?? null,
      resolvedDamId: r?.id ?? null,
    });
    if (!r) {
      log(`jwa-toyokawa: no master match for "${m.toyoName}" (${m.masterName})`);
      continue;
    }
    matches.push({ toyoName: m.toyoName, damId: r.id });
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object('jwa-toyokawa', ${m.toyoName}::text)
      WHERE id = ${r.id}
        AND COALESCE(external_ids->>'jwa-toyokawa', '') <> ${m.toyoName}
    `;
  }
  await recordUniverse('jwa-toyokawa', universe);
  return matches;
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();
  const matches = await ensureExternalIds(log);
  log(`jwa-toyokawa: matched ${matches.length}/${NAME_MAP.length} master dams`);

  const r = await fetch(PAGE_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) {
    log(`jwa-toyokawa: HTTP ${r.status}; aborting`);
    return;
  }
  const html = await r.text();
  const { observedAt, rows: parsed } = parseToyokawaHtml(html);
  log(
    `jwa-toyokawa: parsed ${parsed.length} rows, observedAt=${observedAt?.toISOString() ?? '(missing)'}`,
  );

  if (!observedAt) {
    log('jwa-toyokawa: no timestamp found; aborting');
    return;
  }

  const matchByName = new Map(matches.map((m) => [m.toyoName, m.damId]));
  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const row of parsed) {
    const damId = matchByName.get(row.toyoName);
    if (!damId) continue;
    inputs.push({
      observedAt,
      damId,
      sourceId: 'jwa-toyokawa',
      storageVolumeM3: row.storageVolumeM3,
      storageRate: null, // 有効貯水量 in m³; no rate denominator on page
      inflowM3s: row.inflowM3s,
      outflowM3s: row.outflowM3s,
      waterLevelM: row.waterLevelM,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }
  const written = await upsertObservations(inputs);
  log(`jwa-toyokawa done: parsed=${parsed.length} matched=${matches.length} written=${written}`);
};

export default task;
