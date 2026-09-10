// apps/worker/src/tasks/ingest_aomori.ts
//
// Eighth real-observation source. 青森県 砂防ダム情報 publishes a real-time
// dashboard at kasensabo.bousai.pref.aomori.jp with 7 dams' current level
// + inflow + outflow embedded as a Shift_JIS HTML page:
//
//   下湯, 浅虫, 久吉, 遠部, 浅瀬石川, 津軽 (国管理), 清水目
//
// Per-dam block layout (after Shift_JIS decode):
//   <td class="kyokuname" ...>{name}ダム</td>
//   ... <td class="BoxtdData">{level}m</td>
//   ... <td class="BoxtdData">{inflow}m³/s</td>
//   ... <td class="BoxtdData">{outflow}m³/s</td>
//
// Page header carries the live timestamp 「YYYY年MM月DD日HH時MM分 現在」.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { type UniverseRow, recordUniverse } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const PAGE_URL =
  process.env.AOMORI_DAM_URL ??
  'https://www.kasensabo.bousai.pref.aomori.jp/bousai/static/dam/map_0_0.html';

interface DamCfg {
  aomoriName: string;
  masterName: string;
}

const DAMS: DamCfg[] = [
  { aomoriName: '下湯ダム', masterName: '下湯' },
  { aomoriName: '浅虫ダム', masterName: '浅虫' },
  { aomoriName: '久吉ダム', masterName: '久吉' },
  { aomoriName: '遠部ダム', masterName: '遠部' },
  { aomoriName: '浅瀬石川ダム', masterName: '浅瀬石川' },
  { aomoriName: '津軽ダム', masterName: '津軽' },
  { aomoriName: '清水目ダム', masterName: '清水目' },
];

const PREF_CODE = '02';

interface ParsedRow {
  aomoriName: string;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

function parseNum(s: string): number | null {
  // Source values look like "265.22m", "12.91m³/s" — strip units + commas.
  const t = s
    .replace(/[m³,\s　]/g, '')
    .replace(/\/s/g, '')
    .replace(/&sup3;/g, '');
  if (!t || t === '―' || t === '-' || t === '欠測' || t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Parse 「2026年05月15日23時40分 現在」 → JST → UTC Date. */
export function parseAomoriTimestamp(html: string): Date | null {
  const m = html.match(/(\d{4})年(\d{1,2})月(\d{1,2})日(\d{1,2})時(\d{1,2})分/);
  if (!m) return null;
  return new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0, 0),
  );
}

export function parseAomoriPage(html: string, knownNames: Set<string>): ParsedRow[] {
  const out: ParsedRow[] = [];
  // Page layout per dam block (in document order):
  //   <td>貯水位</td><td class="BoxtdData">{level}m</td>
  //   <td>流入量</td><td class="BoxtdData">{inflow}m³/s</td>
  //   <td>全放流量</td><td class="BoxtdData">{outflow}m³/s</td>
  //   ... 5-7 lines of separator markup ...
  //   <td class="kyokuname" ...>{name}ダム</td>
  //
  // So we match data triplet → trailing dam name.
  const re =
    /class="BoxtdData">([^<]+)<[\s\S]{0,400}?class="BoxtdData">([^<]+)<[\s\S]{0,400}?class="BoxtdData">([^<]+)<[\s\S]{0,800}?class="kyokuname"[^>]*>([^<]+ダム)</g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
  while ((m = re.exec(html)) !== null) {
    const name = m[4] ?? '';
    if (!knownNames.has(name)) continue;
    out.push({
      aomoriName: name,
      waterLevelM: parseNum(m[1] ?? ''),
      inflowM3s: parseNum(m[2] ?? ''),
      outflowM3s: parseNum(m[3] ?? ''),
    });
  }
  return out;
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES ('aomori-dam', 306,
            '青森県砂防ダム情報 — hourly, 7 dams (下湯/浅虫/久吉/遠部/浅瀬石川/津軽/清水目)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

interface DamMatch {
  aomoriName: string;
  damId: bigint;
}

async function ensureExternalIds(log: (s: string) => void): Promise<DamMatch[]> {
  const matches: DamMatch[] = [];
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];
  for (const c of DAMS) {
    const rows = await sql<{ id: bigint; name: string }[]>`
      SELECT id, name FROM dams
      WHERE pref_code = ${PREF_CODE}
        AND name LIKE ${`%${c.masterName}%`}
      ORDER BY
        CASE
          WHEN name = ${c.masterName} THEN 0
          WHEN name = ${`${c.masterName}ダム`} THEN 1
          WHEN name LIKE ${`${c.masterName}（再）%`} THEN 2
          ELSE 5
        END,
        id
      LIMIT 1
    `;
    const r = rows[0];
    universe.push({
      externalId: c.aomoriName,
      name: c.aomoriName,
      prefCode: PREF_CODE,
      resolvedDamId: r?.id ?? null,
    });
    if (!r) {
      log(`aomori-dam: no master match for ${c.aomoriName}`);
      continue;
    }
    matches.push({ aomoriName: c.aomoriName, damId: r.id });
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object('aomori-dam', ${c.aomoriName}::text)
      WHERE id = ${r.id}
        AND COALESCE(external_ids->>'aomori-dam', '') <> ${c.aomoriName}
    `;
  }
  await recordUniverse('aomori-dam', universe);
  return matches;
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();
  const matches = await ensureExternalIds(log);
  log(`aomori-dam: matched ${matches.length}/${DAMS.length} master dams`);

  const r = await fetch(PAGE_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (r.status !== 200) {
    log(`aomori-dam: HTTP ${r.status}; aborting`);
    return;
  }
  // Shift_JIS encoded.
  const buf = await r.arrayBuffer();
  const html = new TextDecoder('shift_jis').decode(buf);
  const observedAt = parseAomoriTimestamp(html);
  if (!observedAt) {
    log('aomori-dam: could not parse page timestamp; aborting');
    return;
  }
  const parsed = parseAomoriPage(html, new Set(DAMS.map((d) => d.aomoriName)));
  log(`aomori-dam: parsed ${parsed.length} dam rows at ${observedAt.toISOString()}`);

  const matchByName = new Map(matches.map((m) => [m.aomoriName, m.damId]));
  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const row of parsed) {
    const damId = matchByName.get(row.aomoriName);
    if (!damId) continue;
    inputs.push({
      observedAt,
      damId,
      sourceId: 'aomori-dam',
      storageVolumeM3: null,
      storageRate: null,
      inflowM3s: row.inflowM3s,
      outflowM3s: row.outflowM3s,
      waterLevelM: row.waterLevelM,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }
  const written = await upsertObservations(inputs);
  log(`aomori-dam done: parsed=${parsed.length} matched=${matches.length} written=${written}`);
};

export default task;
