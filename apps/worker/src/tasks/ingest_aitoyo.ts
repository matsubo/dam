// apps/worker/src/tasks/ingest_aitoyo.ts
//
// Third real-observation source. 公益財団法人 愛知・豊川用水振興協会
// (あいとよネット) publishes a daily-updated table of 利水容量・貯水量・貯水率
// for the 7 dams that supply 愛知 / 木曽川 / 豊川 / 矢作川 systems:
//
//   木曽川水系 4 dams: 牧尾 / 阿木川 / 味噌川 / 岩屋
//   豊川水系   1 dam:  宇連 (+ 豊川用水全体 aggregate, skipped)
//   矢作川水系 2 dams: 矢作 / 羽布
//
// Source: https://www.aitoyo.or.jp/fountainhead/dam/
// Format: HTML table (TablePress plugin); the value timestamp is the
//         daily 24:00 JST (木曽川/豊川) or 09:00 JST (矢作川). Source has
//         a 1-2 day publication lag for confirmed values.
// License: 公益財団法人 publication; 出典明示で再配布可 (public utility data).
//
// Cadence trade-off: daily (vs jwa-junpo's 10-day) for 5 overlap dams.
// Priority 295 (below tokyo-waterworks 300 since tokyo is fresher by ~1 day,
// but above jwa-junpo 290 since aitoyo is fresher than jwa-junpo for overlap).

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { type UniverseRow, recordUniverse } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const PAGE_URL = process.env.AITOYO_URL ?? 'https://www.aitoyo.or.jp/fountainhead/dam/';

const NAME_MAP: Array<{ aitoyoName: string; masterName: string; prefCodes: string[] }> = [
  // 木曽川水系 (all overlap with jwa-junpo)
  { aitoyoName: '牧尾ダム', masterName: '牧尾', prefCodes: ['20'] }, // 長野
  { aitoyoName: '阿木川ダム', masterName: '阿木川', prefCodes: ['21'] }, // 岐阜
  { aitoyoName: '味噌川ダム', masterName: '味噌川', prefCodes: ['20'] },
  { aitoyoName: '岩屋ダム', masterName: '岩屋', prefCodes: ['21'] },
  // 豊川水系 (overlap)
  { aitoyoName: '宇連ダム', masterName: '宇連', prefCodes: ['23'] }, // 愛知
  // 矢作川水系 (NEW vs jwa-junpo / tokyo-waterworks)
  { aitoyoName: '矢作ダム', masterName: '矢作', prefCodes: ['23', '20'] }, // 愛知/長野 boundary
  { aitoyoName: '羽布ダム', masterName: '羽布', prefCodes: ['23'] }, // 愛知
];

// Aggregate rows in the aitoyo table — skip these.
const SKIP_NAMES = new Set(['豊川用水全体']);

interface ParsedRow {
  aitoyoName: string;
  storageCapacityThouM3: number;
  storageVolumeThouM3: number;
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
  const cleaned = s.replace(/[,\s　]/g, '');
  if (!cleaned || cleaned === '―' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Parse 「2026年5月11日現在」 → JST midnight Date for that date. */
export function parseAitoyoDate(text: string): Date | null {
  const m = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  const yr = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  if (!yr || !mo || !day) return null;
  const d = new Date(Date.UTC(yr, mo - 1, day - 1, 15, 0, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseAitoyoHtml(html: string): { reportDate: Date | null; rows: ParsedRow[] } {
  const reportDate = parseAitoyoDate(html);
  const out: ParsedRow[] = [];
  const knownNames = new Set(NAME_MAP.map((m) => m.aitoyoName));

  // Restrict to the dam-storage table. The page has multiple tables; this
  // one is the only one with column-3..column-7 storage cells.
  const tableMatch = html.match(/<table[^>]*tablepress-id-top[^>]*>([\s\S]*?)<\/table>/);
  const tableHtml = tableMatch?.[1] ?? '';
  if (!tableHtml) return { reportDate, rows: out };

  const seen = new Set<string>();
  const rowMatches = tableHtml.match(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g) ?? [];
  for (const row of rowMatches) {
    // Cells with `column-2` carry the dam-name <a>. column-3 is 利水容量,
    // column-4 is 貯水量, column-5 is 貯水率. Use class-keyed extraction so
    // the (variable-width) 水系 rowspan column doesn't shift indices.
    const cellByClass: Record<string, string> = {};
    const cellMatches = row.matchAll(/<td\b[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/td>/g);
    for (const cm of cellMatches) {
      const cls = (cm[1] ?? '').split(/\s+/).find((c) => /^column-\d+$/.test(c));
      if (cls) cellByClass[cls] = textOf(cm[2] ?? '');
    }
    const name = cellByClass['column-2'];
    if (!name) continue;
    if (SKIP_NAMES.has(name) || !knownNames.has(name)) continue;
    const capacity = parseNum(cellByClass['column-3'] ?? '');
    const volume = parseNum(cellByClass['column-4'] ?? '');
    const rate = parseNum(cellByClass['column-5'] ?? '');
    if (capacity == null || volume == null || rate == null) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      aitoyoName: name,
      storageCapacityThouM3: capacity,
      storageVolumeThouM3: volume,
      storageRatePct: rate,
    });
  }
  return { reportDate, rows: out };
}

interface DamMatch {
  aitoyoName: string;
  damId: bigint;
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES ('aitoyo', 295,
            'あいとよネット (公益財団法人 愛知・豊川用水振興協会) — daily, 7 dams in 木曽川/豊川/矢作川 系',
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
          WHEN name = ${`${m.masterName}ダム`} THEN 0
          WHEN name = ${m.masterName} THEN 1
          WHEN name LIKE ${`${m.masterName}（再）%`} THEN 2
          WHEN name = ${`${m.masterName}貯水池`} THEN 3
          WHEN name LIKE ${`${m.masterName}（元）%`} THEN 9
          ELSE 5
        END,
        id
      LIMIT 1
    `;
    const r = rows[0];
    // 矢作 straddles two prefectures; the first is its primary one. prefCode is
    // metadata here, not part of the (source_id, external_id) key.
    universe.push({
      externalId: m.aitoyoName,
      name: m.aitoyoName,
      prefCode: m.prefCodes[0] ?? null,
      resolvedDamId: r?.id ?? null,
    });
    if (!r) {
      log(`aitoyo: no master match for "${m.aitoyoName}" (${m.masterName})`);
      continue;
    }
    matches.push({ aitoyoName: m.aitoyoName, damId: r.id });
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object('aitoyo', ${m.aitoyoName}::text)
      WHERE id = ${r.id}
        AND COALESCE(external_ids->>'aitoyo', '') <> ${m.aitoyoName}
    `;
  }
  await recordUniverse('aitoyo', universe);
  return matches;
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();
  const matches = await ensureExternalIds(log);
  log(`aitoyo: matched ${matches.length}/${NAME_MAP.length} master dams`);

  const r = await fetch(PAGE_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) {
    log(`aitoyo: HTTP ${r.status} from ${PAGE_URL}; aborting`);
    return;
  }
  const html = await r.text();
  const { reportDate, rows: parsed } = parseAitoyoHtml(html);
  log(
    `aitoyo: parsed ${parsed.length} dam rows, reportDate=${reportDate?.toISOString() ?? '(missing)'}`,
  );
  if (!reportDate) {
    log('aitoyo: could not parse year/month/day from header; aborting');
    return;
  }

  const matchByName = new Map(matches.map((m) => [m.aitoyoName, m.damId]));
  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const row of parsed) {
    const damId = matchByName.get(row.aitoyoName);
    if (!damId) continue;
    const storageVolumeM3 = row.storageVolumeThouM3 * 1_000;
    const storageRate = Math.max(0, Math.min(1, row.storageRatePct / 100));
    inputs.push({
      observedAt: reportDate,
      damId,
      sourceId: 'aitoyo',
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
  log(`aitoyo done: parsed=${parsed.length} matched=${matches.length} written=${written}`);
};

export default task;
