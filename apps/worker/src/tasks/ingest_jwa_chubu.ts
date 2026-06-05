// apps/worker/src/tasks/ingest_jwa_chubu.ts
//
// 水資源機構 中部支社 — 木曽川水系 6 dams.
// Publishes a daily-updated water-source status report:
//
//   木曽川水系: 牧尾/阿木川/味噌川/岩屋/中里/徳山
//
// Source: https://www.water.go.jp/mizu/chubu/report/
// Format: Static HTML; date "YYYY年MM月DD日"; storage units 千m³.
//         Also provides 流入量 and 放流量 (m³/s) — richer than jwa-junpo.
// License: 水資源機構 published; 出典明示で再配布可.
//
// New coverage: 中里ダム (not in jwa-junpo).
// Overlap (牧尾/阿木川/味噌川/岩屋/徳山): provides inflow/outflow and daily
// cadence vs jwa-junpo's 10-day. aitoyo has same 5 overlap dams at priority 295,
// so jwa-chubu (296) becomes preferredSource for them when both present.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import type { Task } from 'graphile-worker';

const PAGE_URL = process.env.JWA_CHUBU_URL ?? 'https://www.water.go.jp/mizu/chubu/report/';

const NAME_MAP: Array<{ chubuName: string; masterName: string; prefCodes: string[] }> = [
  { chubuName: '牧尾ダム', masterName: '牧尾', prefCodes: ['20'] }, // 長野
  { chubuName: '阿木川ダム', masterName: '阿木川', prefCodes: ['21'] }, // 岐阜
  { chubuName: '味噌川ダム', masterName: '味噌川', prefCodes: ['20'] },
  { chubuName: '岩屋ダム', masterName: '岩屋', prefCodes: ['21'] },
  { chubuName: '中里ダム', masterName: '中里', prefCodes: ['20'] }, // 長野 (new)
  { chubuName: '徳山ダム', masterName: '徳山', prefCodes: ['21'] },
];

interface ParsedRow {
  chubuName: string;
  storageVolumeThouM3: number;
  storageRatePct: number;
  waterLevelM: number | null;
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
  const cleaned = s.replace(/[,\s　%千m³/s]/g, '');
  if (!cleaned || cleaned === '―' || cleaned === '-' || cleaned === '—') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Parse "YYYY年MM月DD日" → JST midnight = UTC day-1 15:00. */
export function parseChubuDate(text: string): Date | null {
  const m = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  const yr = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  if (!yr || !mo || !day) return null;
  const d = new Date(Date.UTC(yr, mo - 1, day - 1, 15, 0, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Extract a section of HTML between the dam name and the next dam name
 * (or end of string), then pull labeled values from it.
 */
function extractDamSection(html: string, damName: string, allNames: string[]): string {
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
  // Match: label text ... number (with optional commas) ... unit
  // The label and value may be separated by HTML tags and whitespace.
  const labelIdx = section.indexOf(label);
  if (labelIdx < 0) return null;
  // Look up to 500 chars after the label for the first number.
  const context = textOf(section.slice(labelIdx, labelIdx + 500));
  const m = context.match(/([\d,]+(?:\.\d+)?)/);
  if (!m) return null;
  return parseNum(m[1]);
}

export function parseChubuHtml(html: string): { reportDate: Date | null; rows: ParsedRow[] } {
  const reportDate = parseChubuDate(html);
  const rows: ParsedRow[] = [];
  const allNames = NAME_MAP.map((m) => m.chubuName);

  for (const m of NAME_MAP) {
    const section = extractDamSection(html, m.chubuName, allNames);
    if (!section) continue;

    // Try labeled extraction first (most reliable).
    let volume = extractLabeled(section, '貯水量');
    const rate = extractLabeled(section, '貯水率');
    const waterLevel = extractLabeled(section, '貯水位');
    const inflow = extractLabeled(section, '流入量');
    const outflow = extractLabeled(section, '放流量');

    // Some page layouts embed 貯水量 inside a % context — fallback: find first
    // 千m³ number after the dam name if labeled extraction failed.
    if (volume == null) {
      const sectionText = textOf(section);
      const vm = sectionText.match(/([\d,]+)\s*千m/);
      if (vm) volume = parseNum(vm[1]);
    }

    if (volume == null || rate == null) continue;
    rows.push({
      chubuName: m.chubuName,
      storageVolumeThouM3: volume,
      storageRatePct: rate,
      waterLevelM: waterLevel,
      inflowM3s: inflow,
      outflowM3s: outflow,
    });
  }
  return { reportDate, rows };
}

interface DamMatch {
  chubuName: string;
  damId: bigint;
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES ('jwa-chubu', 296,
            '水資源機構 中部支社 木曽川水系 — daily, 6 dams with inflow/outflow',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

async function ensureExternalIds(log: (s: string) => void): Promise<DamMatch[]> {
  const matches: DamMatch[] = [];
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
          WHEN name LIKE ${`${m.masterName}（元）%`}  THEN 9
          ELSE 5
        END,
        id
      LIMIT 1
    `;
    const r = rows[0];
    if (!r) {
      log(`jwa-chubu: no master match for "${m.chubuName}" (${m.masterName})`);
      continue;
    }
    matches.push({ chubuName: m.chubuName, damId: r.id });
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object('jwa-chubu', ${m.chubuName}::text)
      WHERE id = ${r.id}
        AND COALESCE(external_ids->>'jwa-chubu', '') <> ${m.chubuName}
    `;
  }
  return matches;
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();
  const matches = await ensureExternalIds(log);
  log(`jwa-chubu: matched ${matches.length}/${NAME_MAP.length} master dams`);

  const r = await fetch(PAGE_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) {
    log(`jwa-chubu: HTTP ${r.status}; aborting`);
    return;
  }
  const html = await r.text();
  const { reportDate, rows: parsed } = parseChubuHtml(html);
  log(
    `jwa-chubu: parsed ${parsed.length} rows, reportDate=${reportDate?.toISOString() ?? '(missing)'}`,
  );

  if (!reportDate) {
    log('jwa-chubu: no reportDate found; aborting to avoid wrong timestamps');
    return;
  }

  const matchByName = new Map(matches.map((m) => [m.chubuName, m.damId]));
  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const row of parsed) {
    const damId = matchByName.get(row.chubuName);
    if (!damId) continue;
    inputs.push({
      observedAt: reportDate,
      damId,
      sourceId: 'jwa-chubu',
      storageVolumeM3: row.storageVolumeThouM3 * 1_000,
      storageRate: Math.max(0, Math.min(1, row.storageRatePct / 100)),
      inflowM3s: row.inflowM3s,
      outflowM3s: row.outflowM3s,
      waterLevelM: row.waterLevelM,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }
  const written = await upsertObservations(inputs);
  log(`jwa-chubu done: parsed=${parsed.length} matched=${matches.length} written=${written}`);
};

export default task;
