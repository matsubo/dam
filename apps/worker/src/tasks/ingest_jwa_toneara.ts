// apps/worker/src/tasks/ingest_jwa_toneara.ts
//
// 水資源機構 関東支社 — 利根川ダム統合管理事務所 / 荒川ダム統合管理事務所.
// Publishes a daily-updated (0時 JST) table of storage volume and rate for
// 13 facilities in the 利根川 and 荒川 water systems:
//
//   利根川系 9: 矢木沢/奈良俣/藤原/相俣/薗原/八ッ場/下久保/草木/渡良瀬貯水池
//   荒川系  4: 二瀬/滝沢/浦山/荒川貯水池
//
// Source: https://www.water.go.jp/honsya/honsya/suigen/sokuhou/toneara/index.html
// Format: Static HTML table; "令和N年M月D日0時現在"; units 万m³.
// License: 水資源機構 published; 出典明示で再配布可.
//
// New coverage vs prior sources:
//   藤原/相俣/薗原/八ッ場/二瀬 are new dams not covered by jwa-junpo/aitoyo.
//   Overlap dams (矢木沢/奈良俣/下久保/草木/浦山/滝沢) get daily cadence here
//   instead of jwa-junpo's 10-day cadence.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { type UniverseRow, recordUniverse } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const PAGE_URL =
  process.env.JWA_TONEARA_URL ??
  'https://www.water.go.jp/honsya/honsya/suigen/sokuhou/toneara/index.html';

const NAME_MAP: Array<{ tonaraName: string; masterName: string; prefCodes: string[] }> = [
  // 利根川水系
  { tonaraName: '矢木沢ダム', masterName: '矢木沢', prefCodes: ['10'] }, // 群馬
  { tonaraName: '奈良俣ダム', masterName: '奈良俣', prefCodes: ['10'] },
  { tonaraName: '藤原ダム', masterName: '藤原', prefCodes: ['10'] },
  { tonaraName: '相俣ダム', masterName: '相俣', prefCodes: ['10'] },
  { tonaraName: '薗原ダム', masterName: '薗原', prefCodes: ['10'] },
  { tonaraName: '八ッ場ダム', masterName: '八ッ場', prefCodes: ['10', '20'] },
  { tonaraName: '下久保ダム', masterName: '下久保', prefCodes: ['10', '11'] },
  { tonaraName: '草木ダム', masterName: '草木', prefCodes: ['09', '10'] }, // 栃木/群馬
  { tonaraName: '渡良瀬貯水池', masterName: '渡良瀬', prefCodes: ['08', '09', '10', '11'] },
  // 荒川水系
  { tonaraName: '二瀬ダム', masterName: '二瀬', prefCodes: ['11'] }, // 埼玉
  { tonaraName: '滝沢ダム', masterName: '滝沢', prefCodes: ['11'] },
  { tonaraName: '浦山ダム', masterName: '浦山', prefCodes: ['11'] },
  { tonaraName: '荒川貯水池', masterName: '荒川', prefCodes: ['11', '13'] },
];

interface ParsedRow {
  tonaraName: string;
  storageVolumeManM3: number;
  storageRatePct: number;
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
  const cleaned = s.replace(/[,\s　%万m³/]/g, '');
  if (!cleaned || cleaned === '―' || cleaned === '-' || cleaned === '—') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse "令和N年M月D日0時現在" → JST midnight (= UTC day-1 15:00).
 * Reiwa starts 2019 = 令和1, so year = N + 2018.
 */
export function parseToneAraTimestamp(text: string): Date | null {
  const m = text.match(/令和(\d+)年(\d+)月(\d+)日/);
  if (!m) return null;
  const yr = Number(m[1]) + 2018;
  const mo = Number(m[2]);
  const day = Number(m[3]);
  if (!yr || !mo || !day) return null;
  const d = new Date(Date.UTC(yr, mo - 1, day - 1, 15, 0, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Parse HTML table rows. Expected column layout per row:
 *   [0] ダム名  [1] 利水容量(万m³)  [2] 前日(万m³)  [3] 現在(万m³)  [4] 現在貯水率(%)
 */
export function parseToneAraHtml(html: string): { reportDate: Date | null; rows: ParsedRow[] } {
  const reportDate = parseToneAraTimestamp(html);
  const rows: ParsedRow[] = [];
  const knownNames = new Set(NAME_MAP.map((m) => m.tonaraName));
  const seen = new Set<string>();

  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
  while ((m = rowRe.exec(html)) !== null) {
    const cells = [...(m[1] ?? '').matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) =>
      textOf(c[1] ?? ''),
    );
    if (cells.length < 5) continue;
    const name = cells[0] ?? '';
    if (!knownNames.has(name) || seen.has(name)) continue;
    // Column 3 = current storage (万m³), column 4 = storage rate (%).
    const volume = parseNum(cells[3] ?? '');
    const rate = parseNum(cells[4] ?? '');
    if (volume == null || rate == null) continue;
    seen.add(name);
    rows.push({ tonaraName: name, storageVolumeManM3: volume, storageRatePct: rate });
  }
  return { reportDate, rows };
}

interface DamMatch {
  tonaraName: string;
  damId: bigint;
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES ('jwa-toneara', 296,
            '水資源機構 関東支社 利根川/荒川系 — daily 0時, 13 facilities',
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
          WHEN name = ${`${m.masterName}ダム`}        THEN 0
          WHEN name = ${m.masterName}                  THEN 1
          WHEN name = ${`${m.masterName}貯水池`}       THEN 2
          WHEN name LIKE ${`${m.masterName}（再）%`}   THEN 3
          WHEN name LIKE ${`${m.masterName}（元）%`}   THEN 9
          ELSE 5
        END,
        id
      LIMIT 1
    `;
    const r = rows[0];
    universe.push({
      externalId: m.tonaraName,
      name: m.tonaraName,
      // A multi-code entry is a LIKE-narrowing hint, not an attribution — its
      // first code is sometimes the wrong prefecture (草木 is 群馬, not 栃木),
      // and pref_code is COALESCE-sticky once written.
      prefCode: m.prefCodes.length === 1 ? (m.prefCodes[0] ?? null) : null,
      resolvedDamId: r?.id ?? null,
    });
    if (!r) {
      log(`jwa-toneara: no master match for "${m.tonaraName}" (${m.masterName})`);
      continue;
    }
    matches.push({ tonaraName: m.tonaraName, damId: r.id });
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object('jwa-toneara', ${m.tonaraName}::text)
      WHERE id = ${r.id}
        AND COALESCE(external_ids->>'jwa-toneara', '') <> ${m.tonaraName}
    `;
  }
  await recordUniverse('jwa-toneara', universe);
  return matches;
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();
  const matches = await ensureExternalIds(log);
  log(`jwa-toneara: matched ${matches.length}/${NAME_MAP.length} master dams`);

  const r = await fetch(PAGE_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) {
    log(`jwa-toneara: HTTP ${r.status}; aborting`);
    return;
  }
  const html = await r.text();
  const { reportDate, rows: parsed } = parseToneAraHtml(html);
  log(
    `jwa-toneara: parsed ${parsed.length} rows, reportDate=${reportDate?.toISOString() ?? '(missing)'}`,
  );

  if (!reportDate) {
    log('jwa-toneara: no reportDate found; aborting to avoid wrong timestamps');
    return;
  }

  const matchByName = new Map(matches.map((m) => [m.tonaraName, m.damId]));
  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const row of parsed) {
    const damId = matchByName.get(row.tonaraName);
    if (!damId) continue;
    inputs.push({
      observedAt: reportDate,
      damId,
      sourceId: 'jwa-toneara',
      storageVolumeM3: row.storageVolumeManM3 * 10_000, // 万m³ → m³
      storageRate: Math.max(0, Math.min(1, row.storageRatePct / 100)),
      inflowM3s: null,
      outflowM3s: null,
      waterLevelM: null,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }
  const written = await upsertObservations(inputs);
  log(`jwa-toneara done: parsed=${parsed.length} matched=${matches.length} written=${written}`);
};

export default task;
