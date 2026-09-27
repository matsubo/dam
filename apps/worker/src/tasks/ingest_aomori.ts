// apps/worker/src/tasks/ingest_aomori.ts
//
// Eighth real-observation source. 青森県河川砂防情報提供システム
// (kasensabo.bousai.pref.aomori.jp) publishes a per-dam ダム諸量グラフ page
// with a 10-minute table. We read it for 7 治水 dams:
//
//   下湯, 浅虫, 久吉, 遠部, 浅瀬石川 (国管理), 津軽 (国管理), 清水目
//
// URL: servletBousaiContents?style=dam_graph10m&dk=4&it=0&sn={局番号}&nw=1
// (the 局番号 is the one the ダム諸量状況図 map passes to damGraph()).
// Shift_JIS HTML. The table header row reads, in order:
//
//   時分 | ダム地点 10分[mm] 累加[mm] | 流入量[m³/s] | 全放流量[m³/s] |
//   貯水位[EL.m] | 貯水量(有効容量)[1000m³] | 貯水率(有効容量)[%] |
//   貯水率(利水容量)[%]
//
// and each data row is <th class="title time">HH:MM</th> + 8 <td> cells.
// "---" = 無効/閉局/保守, "***" = 欠測, empty = 未受信. The page shows a
// 4-hour window; the date header above it is the window's END date, so rows
// before a midnight wrap belong to the previous day.
//
// 貯水率: prefer 利水容量. Back-solving the live page (2026-09-27) shows 有効
// is the annual 有効貯水容量 (下湯 2,111/0.192 = 10,995 千m³ vs master
// 11,000; 久吉 6,070 vs 6,070; 浅虫 170 vs 170), while 利水 divides by a
// smaller, season-aware pool (津軽 42,561/0.578 = 73,635 vs annual 127,200;
// 世増 reads 100 % at its 洪水貯留準備水位, 3 m below 平常時最高水位). 治水-only
// dams (遠部, 清水目) print "---" for 利水; for those we fall back to the 有効
// rate, which is volume / annual 有効 — the same figure the site would derive
// from the static capacity, so back-solving it is an identity.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const GRAPH_URL =
  process.env.AOMORI_DAM_URL ??
  'https://www.kasensabo.bousai.pref.aomori.jp/bousai/servlet/bousaiweb.servletBousaiContents';

interface DamCfg {
  aomoriName: string;
  masterName: string;
  /** 局番号 (sn) of the dam's ダム諸量グラフ page. */
  stationNo: number;
}

const DAMS: DamCfg[] = [
  { aomoriName: '下湯ダム', masterName: '下湯', stationNo: 1 },
  { aomoriName: '浅虫ダム', masterName: '浅虫', stationNo: 2 },
  { aomoriName: '久吉ダム', masterName: '久吉', stationNo: 6 },
  { aomoriName: '遠部ダム', masterName: '遠部', stationNo: 7 },
  { aomoriName: '浅瀬石川ダム', masterName: '浅瀬石川', stationNo: 40 },
  { aomoriName: '津軽ダム', masterName: '津軽', stationNo: 41 },
  { aomoriName: '清水目ダム', masterName: '清水目', stationNo: 26 },
];

const PREF_CODE = '02';

export interface AomoriRow {
  observedAt: Date;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  storageVolumeM3: number | null;
  /** Fraction (1.0 = 100 %): 利水容量 basis, 有効容量 when 利水 is blank. */
  storageRate: number | null;
}

function parseNum(s: string): number | null {
  const t = s.replace(/&nbsp;/g, '').trim();
  if (!t || t === '---' || t === '***') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// Guards the positional cell mapping below: if the provider reorders or
// renames the volume / rate columns we must not store one as the other.
const HEADER_RE =
  /流入量<br>[\s\S]*?全放流量<br>[\s\S]*?貯水位<br>[\s\S]*?貯水量<br>\(有効容量\)[\s\S]*?貯水率<br>\(有効容量\)[\s\S]*?貯水率<br>\(利水容量\)/;

const ROW_RE =
  /<th[^>]*class="title time"[^>]*>(\d{2}):(\d{2})[^<]*<\/th>((?:\s*<td[^>]*>[^<]*<\/td>){8})/g;

/** Parse one ダム諸量グラフ (10分) page into dated rows that carry dam data. */
export function parseAomoriDamGraph(html: string): AomoriRow[] {
  const dm = html.match(/class="date">(\d{4})年(\d{1,2})月(\d{1,2})日</);
  if (!dm || !HEADER_RE.test(html)) return [];
  const [y, mo, d] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];

  const raw: { minutes: number; cells: string[] }[] = [];
  for (const m of html.matchAll(ROW_RE)) {
    const cells = [...(m[3] ?? '').matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((c) => c[1] ?? '');
    raw.push({ minutes: Number(m[1]) * 60 + Number(m[2]), cells });
  }

  // The last row sits on the header date; walk backwards and step back a day
  // each time the clock wraps.
  const dayOffset: number[] = new Array(raw.length).fill(0);
  for (let i = raw.length - 2; i >= 0; i--) {
    const next = raw[i + 1];
    const cur = raw[i];
    if (!cur || !next) continue;
    dayOffset[i] = (dayOffset[i + 1] ?? 0) - (cur.minutes > next.minutes ? 1 : 0);
  }

  const out: AomoriRow[] = [];
  raw.forEach((r, i) => {
    // cells: [0] 10分雨量 [1] 累加雨量 [2] 流入量 [3] 全放流量 [4] 貯水位
    //        [5] 貯水量(有効) 千m³ [6] 貯水率(有効) % [7] 貯水率(利水) %
    const inflow = parseNum(r.cells[2] ?? '');
    const outflow = parseNum(r.cells[3] ?? '');
    const level = parseNum(r.cells[4] ?? '');
    const volume = parseNum(r.cells[5] ?? '');
    const ratePct = parseNum(r.cells[7] ?? '') ?? parseNum(r.cells[6] ?? '');
    if (
      inflow === null &&
      outflow === null &&
      level === null &&
      volume === null &&
      ratePct === null
    ) {
      return;
    }
    const hh = Math.floor(r.minutes / 60);
    const mm = r.minutes % 60;
    out.push({
      observedAt: new Date(Date.UTC(y, mo - 1, d + (dayOffset[i] ?? 0), hh - 9, mm)),
      waterLevelM: level,
      inflowM3s: inflow,
      outflowM3s: outflow,
      storageVolumeM3: volume !== null ? volume * 1_000 : null,
      storageRate: ratePct !== null ? ratePct / 100 : null,
    });
  });
  return out;
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES ('aomori-dam', 306,
            '青森県河川砂防情報提供システム ダム諸量グラフ — hourly, 7 dams (下湯/浅虫/久吉/遠部/浅瀬石川/津軽/清水目)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

interface DamMatch {
  cfg: DamCfg;
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
    matches.push({ cfg: c, damId: r.id });
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

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const { cfg, damId } of matches) {
    const url = `${GRAPH_URL}?style=dam_graph10m&dk=4&it=0&sn=${cfg.stationNo}&nw=1`;
    const r = await fetch(url, {
      headers: {
        'user-agent':
          process.env.HTTP_USER_AGENT ??
          'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status !== 200) {
      log(`aomori-dam: ${cfg.aomoriName} HTTP ${r.status}; skipping`);
      continue;
    }
    const html = new TextDecoder('shift_jis').decode(await r.arrayBuffer());
    const latest = parseAomoriDamGraph(html).at(-1);
    if (!latest) {
      log(`aomori-dam: ${cfg.aomoriName} no parseable rows; skipping`);
      continue;
    }
    inputs.push({
      observedAt: latest.observedAt,
      damId,
      sourceId: 'aomori-dam',
      storageVolumeM3: latest.storageVolumeM3,
      storageRate: latest.storageRate,
      inflowM3s: latest.inflowM3s,
      outflowM3s: latest.outflowM3s,
      waterLevelM: latest.waterLevelM,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }
  const written = await upsertObservations(inputs);
  log(`aomori-dam done: matched=${matches.length} parsed=${inputs.length} written=${written}`);
};

export default task;
