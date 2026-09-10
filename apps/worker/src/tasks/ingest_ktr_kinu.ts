// apps/worker/src/tasks/ingest_ktr_kinu.ts
//
// Eleventh real-observation source. 国土交通省 関東地方整備局 鬼怒川ダム
// 統合管理事務所 publishes a realtime dashboard for its 4 国管理 dams
// (栃木県): 五十里 / 川俣 / 川治 / 湯西川.
//
//   https://www.ktr.mlit.go.jp/kinudamu/daminfo/jp/realDM.html
//
// Data is embedded inline as JavaScript variables in the HTML:
//
//   KansokuT = ['YYYY-MM-DD-HH-MM', ...4 items];
//   DamVal = [
//     [[validFlag, raw_int, displayStr, prevValid, prevRaw, dataNo], ... 7 rows],
//     ... 4 dams
//   ];
//
// Per-dam row mapping (DamVal[s][n]):
//   [s][0]: 貯水位 (m)        — divide displayStr by 1
//   [s][1]: 全流入量 (m³/s)
//   [s][2]: 調整流量 (m³/s)
//   [s][3]: ダム放流量 (m³/s)
//   [s][4]: 全放流量 (m³/s)   — preferred for outflow
//   [s][5]: 発電使用水量
//   [s][6]: 累加雨量 (mm)

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { type UniverseRow, recordUniverse } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const PAGE_URL =
  process.env.KTR_KINU_DAM_URL ?? 'https://www.ktr.mlit.go.jp/kinudamu/daminfo/jp/realDM.html';

interface DamCfg {
  /** Index into KansokuT / DamVal (0..3). */
  idx: number;
  /** Slug used in DamTbl (`ikari`, `kawamata`, `kawaji`, `yunishigawa`). */
  slug: string;
  pageName: string;
  /** Substring used to LIKE-match against master `dams.name`. */
  masterName: string;
}

const DAMS: DamCfg[] = [
  { idx: 0, slug: 'ikari', pageName: '五十里ダム', masterName: '五十里' },
  { idx: 1, slug: 'kawamata', pageName: '川俣ダム', masterName: '川俣' },
  { idx: 2, slug: 'kawaji', pageName: '川治ダム', masterName: '川治' },
  { idx: 3, slug: 'yunishigawa', pageName: '湯西川ダム', masterName: '湯西川' },
];

const PREF_CODE = '09';
const SOURCE_ID = 'ktr-kinu-dam';

interface ParsedDam {
  observedAt: Date;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  rainfallMm: number | null;
}

function parseDisplayNum(s: string | undefined): number | null {
  if (!s) return null;
  const t = s.replace(/[,\s　]/g, '');
  if (!t || t === '-' || t === '−' || t === '欠測') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Parse "2026-05-18-14-50" (JST) → UTC Date. */
export function parseKinuTimestamp(raw: string): Date | null {
  const m = raw.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0, 0),
  );
}

/**
 * Extract `KansokuT` and `DamVal` arrays from the inline JS in realDM.html.
 * Returns one ParsedDam per master-config DAM in order.
 */
export function parseKinuPage(html: string): (ParsedDam | null)[] {
  // KansokuT block:  KansokuT = [ 'YYYY-...', 'YYYY-...', ... ];
  const ksMatch = html.match(/KansokuT\s*=\s*\[([\s\S]*?)\];/);
  // DamVal block: capture the full outer-array body including its closing `]`.
  // Pattern: starts at `DamVal = [`, ends at the OUTER `];`. Inside, every
  // `]` matches an earlier `[` so the non-greedy capture must end at the
  // outermost closing. We capture between the opening `[` and the final
  // `]` (exclusive of the trailing `;`).
  const dvOuter = html.match(/DamVal\s*=\s*(\[[\s\S]*?\]\s*\]);/);
  if (!ksMatch || !dvOuter) return DAMS.map(() => null);
  const tsRaw = [...(ksMatch[1] ?? '').matchAll(/'([\d-]+)'/g)].map((m) => m[1] ?? '');
  // Strip the outer `[ ... ]` to get the body containing the 4 sub-arrays.
  const dvFull = dvOuter[1] ?? '';
  const dvBody = dvFull.replace(/^\s*\[/, '').replace(/\]\s*$/, '');
  const subs: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < dvBody.length; i++) {
    const ch = dvBody[i];
    if (ch === '[') {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (ch === ']') {
      depth--;
      if (depth === 0 && start >= 0) {
        subs.push(dvBody.slice(start, i));
        start = -1;
      }
    }
  }
  // For each dam sub-array, extract the 7 inner rows, then pull displayStr (col 2).
  const rowsPerDam = subs.map((s) => {
    const rows: string[] = [];
    let d = 0;
    let rs = -1;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '[') {
        if (d === 0) rs = i + 1;
        d++;
      } else if (ch === ']') {
        d--;
        if (d === 0 && rs >= 0) {
          rows.push(s.slice(rs, i));
          rs = -1;
        }
      }
    }
    return rows.map((r) => {
      const cols = r.split(',').map((c) => c.trim().replace(/^['"]|['"]$/g, ''));
      return cols;
    });
  });
  return DAMS.map((c) => {
    const ts = parseKinuTimestamp(tsRaw[c.idx] ?? '');
    const rows = rowsPerDam[c.idx];
    if (!ts || !rows) return null;
    const display = (n: number): string | undefined => rows[n]?.[2];
    return {
      observedAt: ts,
      waterLevelM: parseDisplayNum(display(0)),
      inflowM3s: parseDisplayNum(display(1)),
      outflowM3s: parseDisplayNum(display(4)) ?? parseDisplayNum(display(3)),
      rainfallMm: parseDisplayNum(display(6)),
    };
  });
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 303,
            '国土交通省 関東地方整備局 鬼怒川ダム統合管理事務所 — hourly, 4 dams (五十里/川俣/川治/湯西川)',
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
    // `slug` is the page's own DamTbl key.
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

  const r = await fetch(PAGE_URL, {
    headers: { 'user-agent': userAgent },
    signal: AbortSignal.timeout(12_000),
  });
  if (r.status !== 200) {
    log(`${SOURCE_ID}: HTTP ${r.status}; abort`);
    return;
  }
  const html = await r.text();
  const parsed = parseKinuPage(html);
  const matchByIdx = new Map(matches.map((m) => [m.cfg.idx, m.damId]));
  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (let i = 0; i < DAMS.length; i++) {
    const p = parsed[i];
    const damId = matchByIdx.get(i);
    if (!p || !damId) continue;
    if (p.waterLevelM == null && p.inflowM3s == null && p.outflowM3s == null) {
      continue;
    }
    inputs.push({
      observedAt: p.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: null,
      storageRate: null,
      inflowM3s: p.inflowM3s,
      outflowM3s: p.outflowM3s,
      waterLevelM: p.waterLevelM,
      rainfallMm: p.rainfallMm,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }
  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: matched=${matches.length} parsed=${inputs.length} written=${written}`);
};

export default task;
