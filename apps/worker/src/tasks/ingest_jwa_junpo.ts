// apps/worker/src/tasks/ingest_jwa_junpo.ts
//
// Second real-observation source. 水資源機構 (JWA) publishes a 旬報 (10-day
// report) for the 26 JWA-operated dams across 7 major water systems:
//
//   利根川 4 dams: 矢木沢 / 奈良俣 / 下久保 / 草木
//   荒川   2 dams: 浦山 / 滝沢
//   木曾川 5 dams: 徳山 / 岩屋 / 阿木川 / 牧尾 / 味噌川
//   豊川   2 dams: 宇連 / 大島
//   淀川   8 dams: 高山 / 青蓮寺 / 室生 / 布目 / 比奈知 / 川上 / 一庫 / 日吉
//   吉野川 1 dam:  早明浦
//   筑後川 4 dams: 江川 / 小石川原 / 寺内 / 大山
//
// Source: https://www.water.go.jp/honsya/honsya/suigen/junpo/index.html
// Format: HTML table, ~10-day granularity (JWA publishes on the 1st, 11th,
//         and 21st of each month, so the index always shows the latest).
//         Statutory open data (independent administrative agency).
//
// Cadence trade-off: 10 days is much coarser than tokyo-waterworks' daily,
// but JWA covers 20 additional dams (6 overlap with tokyo-waterworks) that
// no daily prefectural source publishes. The chart UI smooths missing days
// from the most recent observed value, so a 10-day step is fine for the
// storage-volume timeline.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import type { Task } from 'graphile-worker';

const PAGE_URL =
  process.env.JWA_JUNPO_URL ?? 'https://www.water.go.jp/honsya/honsya/suigen/junpo/index.html';

// Manual mapping: JWA junpo listing name → master dam.
// `prefCodes` narrows the LIKE match for collisions (e.g. 大島 exists in
// 岐阜 and 愛知; only the 愛知 one is in JWA's 豊川 system).
const NAME_MAP: Array<{ jwaName: string; masterName: string; prefCodes: string[] }> = [
  // 利根川 (overlaps with tokyo-waterworks; serves as cross-source confirmation)
  { jwaName: '矢木沢ダム', masterName: '矢木沢', prefCodes: ['10'] },
  { jwaName: '奈良俣ダム', masterName: '奈良俣', prefCodes: ['10'] },
  { jwaName: '下久保ダム', masterName: '下久保', prefCodes: ['10', '11'] },
  { jwaName: '草木ダム', masterName: '草木', prefCodes: ['10'] },
  // 荒川 (overlap)
  { jwaName: '浦山ダム', masterName: '浦山', prefCodes: ['11'] },
  { jwaName: '滝沢ダム', masterName: '滝沢', prefCodes: ['11'] },
  // 木曾川 (new)
  { jwaName: '徳山ダム', masterName: '徳山', prefCodes: ['21'] }, // 岐阜
  { jwaName: '岩屋ダム', masterName: '岩屋', prefCodes: ['21'] },
  { jwaName: '阿木川ダム', masterName: '阿木川', prefCodes: ['21'] },
  { jwaName: '牧尾ダム', masterName: '牧尾', prefCodes: ['20'] }, // 長野
  { jwaName: '味噌川ダム', masterName: '味噌川', prefCodes: ['20'] },
  // 豊川 (new)
  { jwaName: '宇連ダム', masterName: '宇連', prefCodes: ['23'] }, // 愛知
  { jwaName: '大島ダム', masterName: '大島', prefCodes: ['23'] },
  // 淀川 (new)
  { jwaName: '高山ダム', masterName: '高山', prefCodes: ['26'] }, // 京都
  { jwaName: '青蓮寺ダム', masterName: '青蓮寺', prefCodes: ['24'] }, // 三重
  { jwaName: '室生ダム', masterName: '室生', prefCodes: ['29'] }, // 奈良
  { jwaName: '布目ダム', masterName: '布目', prefCodes: ['29'] },
  { jwaName: '比奈知ダム', masterName: '比奈知', prefCodes: ['24'] },
  { jwaName: '川上ダム', masterName: '川上', prefCodes: ['24'] },
  { jwaName: '一庫ダム', masterName: '一庫', prefCodes: ['28'] }, // 兵庫
  { jwaName: '日吉ダム', masterName: '日吉', prefCodes: ['26'] },
  // 吉野川 (new)
  { jwaName: '早明浦ダム', masterName: '早明浦', prefCodes: ['39'] }, // 高知
  // 筑後川 (new)
  { jwaName: '江川ダム', masterName: '江川', prefCodes: ['40'] }, // 福岡
  { jwaName: '小石川原ダム', masterName: '小石原川', prefCodes: ['40'] }, // junpo lists as 小石川原, master is 小石原川
  { jwaName: '寺内ダム', masterName: '寺内', prefCodes: ['40'] },
  { jwaName: '大山ダム', masterName: '大山', prefCodes: ['44'] }, // 大分
];

// Synthesis rows in the JWA table (multi-dam aggregates) — skip these.
const SKIP_NAMES = new Set(['上流9ダム', '銅山川3ダム']);

interface ParsedRow {
  jwaName: string;
  storageCapacityThouM3: number; // 利水容量, 千m³
  storageVolumeThouM3: number; // 貯水量, 千m³
  storageRatePct: number; // 貯水率 (current), %
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
  if (!cleaned || cleaned === '―' || cleaned === '-' || cleaned === '*' || cleaned === '**') {
    return null;
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse "令和8年4月21日" → JST midnight Date.
 * 令和 (Reiwa) era began 2019-05-01; year N → Gregorian 2018+N.
 */
export function parseReportDate(text: string): Date | null {
  const m = text.match(/令和(\d+)年(\d+)月(\d+)日/);
  if (!m) return null;
  const yr = 2018 + Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  if (!yr || !mo || !day) return null;
  // JST midnight = 15:00 UTC the previous day.
  const d = new Date(Date.UTC(yr, mo - 1, day - 1, 15, 0, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Parse the junpo HTML into one ParsedRow per known JWA dam name. */
export function parseJwaJunpoHtml(html: string): { reportDate: Date | null; rows: ParsedRow[] } {
  const reportDate = parseReportDate(html);
  const out: ParsedRow[] = [];
  const knownNames = new Set(NAME_MAP.map((m) => m.jwaName));

  // The page has multiple <table> elements. Only the first one — the
  // 「ダムの状況（利水容量に対する貯水率）」 table — has 貯水量/貯水率 in
  // 千m³ and %. Subsequent tables hold 月降水量 / 年降水量 (rainfall, mm)
  // for the same dams; if we walked them with the same parsing the
  // numeric values would silently be assigned to the wrong fields.
  const tableMatches = html.match(/<table\b[\s\S]*?<\/table>/g) ?? [];
  const storageTable = tableMatches.find((t) => /貯水率/.test(t)) ?? '';
  if (!storageTable) return { reportDate, rows: out };
  const seen = new Set<string>();

  // Walk every <tr> in the storage table, look for a cell whose trimmed
  // text matches a known JWA dam name; the next cells hold:
  //   利水容量marker / 利水容量 / 貯水量 / 貯水率(現在) / 貯水率(平年) /
  //   貯水率(平年比).
  const rowMatches = storageTable.match(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g) ?? [];
  for (const row of rowMatches) {
    const cellMatches = row.match(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g) ?? [];
    if (cellMatches.length < 5) continue;
    const cells = cellMatches.map((c) => textOf(c.replace(/^<t[hd][^>]*>|<\/t[hd]>$/g, '')));
    // Find the cell that holds the dam name. With rowspan in the 水系 column
    // the dam name can be at cells[0] (first row of a system) or cells[1]
    // (subsequent rows). For synthesis rows or header rows the name may
    // also appear at cells[0].
    const nameIdx = cells.findIndex((c) => knownNames.has(c) || SKIP_NAMES.has(c));
    if (nameIdx < 0) continue;
    const name = cells[nameIdx];
    if (!name || SKIP_NAMES.has(name)) continue;
    // After the name cell: [marker, capacity, volume, rate-current, rate-normal, rate-vs-normal]
    const capacity = parseNum(cells[nameIdx + 2] ?? '');
    const volume = parseNum(cells[nameIdx + 3] ?? '');
    const rate = parseNum(cells[nameIdx + 4] ?? '');
    if (capacity == null || volume == null || rate == null) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      jwaName: name,
      storageCapacityThouM3: capacity,
      storageVolumeThouM3: volume,
      storageRatePct: rate,
    });
  }
  return { reportDate, rows: out };
}

interface DamMatch {
  jwaName: string;
  damId: bigint;
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES ('jwa-junpo', 290,
            '水資源機構 旬報 (real, 10-day cadence, statutory open data)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

/**
 * Idempotent: stamp external_ids->>'jwa-junpo' on the 21 master dams the
 * first time the task runs. Match by (prefCode IN list) AND name LIKE
 * '%<masterName>%', preferring 「<masterName>ダム」, then 「再」/「貯水池」
 * over 「元」 to pick the currently-operating dam when redevelopment has
 * left both versions in the master.
 */
async function ensureExternalIds(log: (s: string) => void): Promise<DamMatch[]> {
  const matches: DamMatch[] = [];
  for (const m of NAME_MAP) {
    const rows = await sql<{ id: bigint; name: string }[]>`
      SELECT id, name FROM dams
      WHERE pref_code = ANY(${m.prefCodes}::text[])
        AND name LIKE ${`%${m.masterName}%`}
      ORDER BY
        CASE
          WHEN name = ${`${m.masterName}ダム`} THEN 0
          WHEN name = ${m.masterName} THEN 1
          WHEN name LIKE ${`${m.masterName}（再）%`} THEN 2
          WHEN name LIKE ${`${m.masterName}（再開発）%`} THEN 2
          WHEN name = ${`${m.masterName}貯水池`} THEN 3
          WHEN name LIKE ${`${m.masterName}（元）%`} THEN 9
          ELSE 5
        END,
        id
      LIMIT 1
    `;
    const r = rows[0];
    if (!r) {
      log(`jwa-junpo: no master match for "${m.jwaName}" (${m.masterName})`);
      continue;
    }
    matches.push({ jwaName: m.jwaName, damId: r.id });
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object('jwa-junpo', ${m.jwaName}::text)
      WHERE id = ${r.id}
        AND COALESCE(external_ids->>'jwa-junpo', '') <> ${m.jwaName}
    `;
  }
  return matches;
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();
  const matches = await ensureExternalIds(log);
  log(`jwa-junpo: matched ${matches.length}/${NAME_MAP.length} master dams`);

  const r = await fetch(PAGE_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) {
    log(`jwa-junpo: HTTP ${r.status} from ${PAGE_URL}; aborting`);
    return;
  }
  const html = await r.text();
  const { reportDate, rows: parsed } = parseJwaJunpoHtml(html);
  log(
    `jwa-junpo: parsed ${parsed.length} dam rows, reportDate=${reportDate?.toISOString() ?? '(missing)'}`,
  );
  if (!reportDate) {
    log('jwa-junpo: could not parse 令和N年M月D日 from page header; aborting');
    return;
  }

  const matchByName = new Map(matches.map((m) => [m.jwaName, m.damId]));
  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const row of parsed) {
    const damId = matchByName.get(row.jwaName);
    if (!damId) continue;
    const storageVolumeM3 = row.storageVolumeThouM3 * 1_000;
    const storageRate = Math.max(0, Math.min(1, row.storageRatePct / 100));
    inputs.push({
      observedAt: reportDate,
      damId,
      sourceId: 'jwa-junpo',
      storageVolumeM3,
      storageRate,
      inflowM3s: null,
      outflowM3s: null,
      waterLevelM: null,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }
  const written = await upsertObservations(inputs);
  log(`jwa-junpo done: parsed=${parsed.length} matched=${matches.length} written=${written}`);
};

export default task;
