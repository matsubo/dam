// apps/worker/src/tasks/ingest_hkd_mlit.ts
//
// Ninth real-observation source. 国土交通省 北海道開発局 publishes a
// realtime dashboard for the 18 dams it directly manages on the
// 札幌/旭川/室蘭/小樽/網走/釧路/帯広/留萌/稚内/函館 sub-bureaus:
//   info-dam.hdb.hkd.mlit.go.jp/dam/dam_{slug}.htm
//
// Per-page layout (UTF-8 HTML):
//   summary block: 貯水量 NN千m³ / 貯水率 NN.N% / 雨量 / 流入量 / 放流量
//   hourly table (10-min cadence; last 24 h):
//     年/月/日 時:分 | 貯水位(m) | 全流入量(m³/s) | 全放流量(m³/s) | ...
//
// We pick the LATEST row of the hourly table (storing 10-min freshness)
// plus the summary 貯水量/貯水率 for that same timestamp.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { type UniverseRow, recordUniverse } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const BASE_URL = process.env.HKD_MLIT_DAM_BASE ?? 'https://info-dam.hdb.hkd.mlit.go.jp/dam';

interface DamCfg {
  slug: string;
  /** Name as it appears in the page's <title> (with か, etc., as-is). */
  pageName: string;
  /** Substring used to LIKE-match against the master `dams.name`. */
  masterName: string;
}

const DAMS: DamCfg[] = [
  { slug: 'biratori_dam', pageName: '平取ダム', masterName: '平取' },
  { slug: 'chubetsu', pageName: '忠別ダム', masterName: '忠別' },
  { slug: 'houheikyou', pageName: '豊平峡ダム', masterName: '豊平峡' },
  { slug: 'iwaonai', pageName: '岩尾内ダム', masterName: '岩尾内' },
  { slug: 'izarigawa', pageName: '漁川ダム', masterName: '漁川' },
  { slug: 'jyouzankei', pageName: '定山渓ダム', masterName: '定山渓' },
  { slug: 'kanayama', pageName: '金山ダム', masterName: '金山' },
  { slug: 'kanoko', pageName: '鹿ノ子ダム', masterName: '鹿ノ子' },
  { slug: 'katsurazawa', pageName: '新桂沢ダム', masterName: '新桂沢' },
  { slug: 'nibutani', pageName: '二風谷ダム', masterName: '二風谷' },
  { slug: 'pirika', pageName: '美利河ダム', masterName: '美利河' },
  { slug: 'rumoi', pageName: '留萌ダム', masterName: '留萌' },
  { slug: 'sanru', pageName: 'サンルダム', masterName: 'サンル' },
  { slug: 'satsunaigawa', pageName: '札内川ダム', masterName: '札内川' },
  { slug: 'taisetsu', pageName: '大雪ダム', masterName: '大雪' },
  { slug: 'takisato', pageName: '滝里ダム', masterName: '滝里' },
  { slug: 'tokachi', pageName: '十勝ダム', masterName: '十勝' },
  { slug: 'yuubari', pageName: '夕張シューパロダム', masterName: '夕張シューパロ' },
];

const PREF_CODE = '01';
const SOURCE_ID = 'hkd-mlit-dam';

interface ParsedDam {
  /** Latest reading timestamp (JST → UTC). */
  observedAt: Date;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  /** Summary storage in千 m³, converted to m³. */
  storageVolumeM3: number | null;
  /** Summary 貯水率 as fraction [0,1]. */
  storageRate: number | null;
  rainfallMm: number | null;
}

function parseNum(s: string): number | null {
  const t = s.replace(/[,\s　]/g, '').replace(/\*/g, '');
  if (!t || t === '欠測' || t === '-' || t === '―') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Parse "26/05/18　10:10" (Reiwa-style 2-digit year, JST) → UTC Date. */
export function parseHkdTimestamp(raw: string): Date | null {
  const m = raw.match(/(\d{2})\/(\d{1,2})\/(\d{1,2})[　 ]+(\d{1,2}):(\d{1,2})/);
  if (!m) return null;
  const yy = Number(m[1]);
  // The page uses 2-digit year that maps to 20YY (e.g. 26 = 2026).
  const yyyy = 2000 + yy;
  return new Date(
    Date.UTC(yyyy, Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0, 0),
  );
}

/** Parse a single dam page (already UTF-8 decoded). */
export function parseHkdDamPage(html: string): ParsedDam | null {
  // The hourly table has rows of 7 columns:
  //   [年/月/日 時:分, 貯水位, 全流入量, 全放流量, ゲート, 発電, 利水]
  // We want the last row (most recent timestamp).
  const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
  const cells: string[] = [];
  let tdMatch: RegExpExecArray | null = tdRe.exec(html);
  while (tdMatch !== null) {
    cells.push(tdMatch[1] ?? '');
    tdMatch = tdRe.exec(html);
  }
  // The 18 most-recent table cells are the last full data row (we filter by
  // whether the cell matches the timestamp pattern to find row starts).
  let lastObservedAt: Date | null = null;
  let lastLevel: number | null = null;
  let lastInflow: number | null = null;
  let lastOutflow: number | null = null;
  // Walk forward to find last timestamp-shaped cell.
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i] ?? '';
    const ts = parseHkdTimestamp(c);
    if (ts && cells.length >= i + 4) {
      lastObservedAt = ts;
      lastLevel = parseNum(cells[i + 1] ?? '');
      lastInflow = parseNum(cells[i + 2] ?? '');
      lastOutflow = parseNum(cells[i + 3] ?? '');
    }
  }
  if (!lastObservedAt) return null;

  // Summary fields (top of page). Storage values:
  //   貯水量　96501千m<sup>3</sup>
  //   貯水率　74.2%
  //   雨量　0.0mm/h
  const storageMatch = html.match(/貯水量[\s　]*([\d,.-]+)千m/);
  const rateMatch = html.match(/貯水率[\s　]*([\d.-]+)%/);
  const rainMatch = html.match(/雨量[\s　]*([\d.-]+)mm\/h/);
  const storageVolumeM3 = storageMatch?.[1]
    ? (parseNum(storageMatch[1]) ?? null) !== null
      ? (parseNum(storageMatch[1]) as number) * 1000
      : null
    : null;
  const rateNum = rateMatch?.[1] ? parseNum(rateMatch[1]) : null;
  const storageRate = rateNum != null ? rateNum / 100 : null;

  return {
    observedAt: lastObservedAt,
    waterLevelM: lastLevel,
    inflowM3s: lastInflow,
    outflowM3s: lastOutflow,
    storageVolumeM3,
    storageRate,
    rainfallMm: rainMatch?.[1] ? parseNum(rainMatch[1]) : null,
  };
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 305,
            '国土交通省 北海道開発局 ダムリアルタイム情報 — hourly, 18 dams',
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

async function matchMaster(log: (s: string) => void): Promise<DamMatch[]> {
  const matches: DamMatch[] = [];
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];
  for (const c of DAMS) {
    const rows = await sql<{ id: bigint }[]>`
      SELECT id FROM dams
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
      externalId: c.slug,
      name: c.pageName,
      prefCode: PREF_CODE,
      resolvedDamId: r?.id ?? null,
    });
    if (!r) {
      log(`${SOURCE_ID}: no master match for ${c.pageName}`);
      continue;
    }
    matches.push({ cfg: c, damId: r.id });
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object(${SOURCE_ID}::text, ${c.slug}::text)
      WHERE id = ${r.id}
        AND COALESCE(external_ids->>${SOURCE_ID}, '') <> ${c.slug}
    `;
  }
  await recordUniverse(SOURCE_ID, universe);
  return matches;
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();
  const matches = await matchMaster(log);
  log(`${SOURCE_ID}: matched ${matches.length}/${DAMS.length} master dams`);

  const userAgent =
    process.env.HTTP_USER_AGENT ??
    'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const m of matches) {
    const url = `${BASE_URL}/dam_${m.cfg.slug}.htm`;
    try {
      const r = await fetch(url, {
        headers: { 'user-agent': userAgent },
        signal: AbortSignal.timeout(12_000),
      });
      if (r.status !== 200) {
        log(`${SOURCE_ID}: ${m.cfg.slug} HTTP ${r.status}; skip`);
        continue;
      }
      const html = await r.text();
      const parsed = parseHkdDamPage(html);
      if (!parsed) {
        log(`${SOURCE_ID}: ${m.cfg.slug} no parseable row; skip`);
        continue;
      }
      inputs.push({
        observedAt: parsed.observedAt,
        damId: m.damId,
        sourceId: SOURCE_ID,
        storageVolumeM3: parsed.storageVolumeM3,
        storageRate: parsed.storageRate,
        inflowM3s: parsed.inflowM3s,
        outflowM3s: parsed.outflowM3s,
        waterLevelM: parsed.waterLevelM,
        rainfallMm: parsed.rainfallMm,
        rawSnapshotId: null,
        qualityFlag: 0,
      });
    } catch (err) {
      log(`${SOURCE_ID}: ${m.cfg.slug} fetch error: ${(err as Error).message}`);
    }
  }
  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: matched=${matches.length} parsed=${inputs.length} written=${written}`);
};

export default task;
