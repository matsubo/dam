// apps/worker/src/tasks/ingest_jwa_aichi_yosui.ts
//
// 水資源機構 愛知用水総合管理所 水情報 — 牧尾ダム + 東郷調整池 (愛知池) + 前山池,
// daily 0時 JST values (page updated ~10:00 JST).
//
// Source: https://www.water.go.jp/chubu/aityosui/b(jyouhou-main)/02(mizu)/00(top)/b-02.html
// Format: UTF-8 HTML (ホームページビルダー nested tables). One header
//         "YYYY年M月D日（曜）H時現在の状況をお知らせします" for the page;
//           牧尾ダム:  水位(標高) [m], 貯水量 [千m³], 貯水率 [%], 流入量, 放流量 [m³/s]
//           調整池表:  東郷調整池 | 前山池 columns of 貯水位 [m], 貯水量 [千m³],
//                      貯水率 [%]
//         貯水率 is 貯水量 / 有効貯水量 (page footnote: 東郷 9,000 / 前山 972
//         千m³; 牧尾 68,000), i.e. the static capacity — not a trusted basis.
//         The page is outside the 中部支社 リアルタイム system (/mizu/chubu/),
//         whose description.pdf asks users not to collect with tools.
// License: 愛知用水総合管理所 サイトポリシー「著作権について」— 私的使用または
//         引用等、著作権法上認められた行為を除き無断転載不可; 引用時は出所明示.
//         水資源機構「著作権・リンク等について」(honsya/policy/copyright): 数値データ、
//         簡単な表・グラフ等は著作権の対象ではなく自由に利用できる. Only the
//         observed numbers are stored, with the source named.
//
// 東郷調整池 and 前山 have no other live source. 牧尾 is here because the page
// publishes it; priority 294 keeps it below every other 牧尾 feed (aitoyo 295,
// jwa-chubu 296, jwa-kiso-rt 297, kasenbosai 310) and above jwa-junpo 290.

import { type BindableMaster, chooseRanked } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const PAGE_URL =
  process.env.JWA_AICHI_YOSUI_URL ??
  'https://www.water.go.jp/chubu/aityosui/b(jyouhou-main)/02(mizu)/00(top)/b-02.html';

const SOURCE_ID = 'jwa-aichi-yosui';

// The page's whole station list. 前山池 is ダム便覧's 前山 (常滑市, ダム湖名
// 前山池, 目的「愛知用水の調整池」, 有効 972 千m³ — the page's own footnote).
const STATIONS: Array<{ name: string; masterName: string; prefCode: string }> = [
  { name: '牧尾ダム', masterName: '牧尾', prefCode: '20' }, // 長野 (木曽郡王滝村)
  { name: '東郷調整池', masterName: '東郷調整池', prefCode: '23' },
  { name: '前山池', masterName: '前山', prefCode: '23' },
];

export interface ParsedRow {
  name: string;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  storageRate: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

/** Cell text → number; 欠測 / blank / any non-numeric → null. */
function parseNum(s: string | undefined): number | null {
  const cleaned = (s ?? '').replace(/,/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function thousandM3(s: string | undefined): number | null {
  const n = parseNum(s);
  return n == null ? null : n * 1000;
}

function percent(s: string | undefined): number | null {
  const n = parseNum(s);
  return n == null ? null : n / 100;
}

// Every cell value is one whitespace-free token once tags are flattened.
const V = '(\\S+)';
const THOUSAND_M3 = '千 ?m ?3';
const MAKIO_RE = new RegExp(
  `牧尾ダム .*?水位 \\(標高\\) ${V} m 貯水量 ${V} ${THOUSAND_M3} 貯水率 ${V} [％%] ` +
    `流入量 ${V} m 3 ／ｓ 放流量 ${V} m 3 ／ｓ`,
);
const PONDS_RE = new RegExp(
  `東郷調整池 前 ?山 ?池 貯水位 ${V} m ${V} m 貯水量 ${V} ${THOUSAND_M3} ${V} ${THOUSAND_M3} ` +
    `貯水率 ${V} [％%] ${V} [％%]`,
);

export function parseAichiYosuiPage(html: string): {
  observedAt: Date | null;
  rows: ParsedRow[];
} {
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[\s　]+/g, ' ');

  // "2026 年 9 月 27 日 日 0 時現在" — the token after 日 is the weekday.
  const t = text.match(/(\d{4}) 年 (\d{1,2}) 月 (\d{1,2}) 日 (?:\S )?(\d{1,2}) 時現在/);
  if (!t) return { observedAt: null, rows: [] };
  // JST → UTC; Date.UTC normalises the negative hour into the previous day.
  const observedAt = new Date(
    Date.UTC(Number(t[1]), Number(t[2]) - 1, Number(t[3]), Number(t[4]) - 9),
  );

  const rows: ParsedRow[] = [];
  const makio = text.match(MAKIO_RE);
  if (makio) {
    rows.push({
      name: '牧尾ダム',
      waterLevelM: parseNum(makio[1]),
      storageVolumeM3: thousandM3(makio[2]),
      storageRate: percent(makio[3]),
      inflowM3s: parseNum(makio[4]),
      outflowM3s: parseNum(makio[5]),
    });
  }
  const ponds = text.match(PONDS_RE);
  if (ponds) {
    rows.push(
      {
        name: '東郷調整池',
        waterLevelM: parseNum(ponds[1]),
        storageVolumeM3: thousandM3(ponds[3]),
        storageRate: percent(ponds[5]),
        inflowM3s: null,
        outflowM3s: null,
      },
      {
        name: '前山池',
        waterLevelM: parseNum(ponds[2]),
        storageVolumeM3: thousandM3(ponds[4]),
        storageRate: percent(ponds[6]),
        inflowM3s: null,
        outflowM3s: null,
      },
    );
  }
  return { observedAt, rows };
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 294,
            '水資源機構 愛知用水総合管理所 水情報 — daily 0時, 3 施設 (牧尾/東郷調整池/前山池)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

async function ensureExternalIds(log: (s: string) => void): Promise<Map<string, bigint>> {
  const damByName = new Map<string, bigint>();
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];
  for (const s of STATIONS) {
    // （元） and （再） rank alike so chooseRanked binds the current twin.
    const candidates = await sql<(BindableMaster & { rank: number })[]>`
      SELECT id, name, completed_year AS "completedYear",
             external_ids->>${SOURCE_ID} AS stamp,
             CASE
               WHEN name = ${`${s.masterName}ダム`}       THEN 0
               WHEN name = ${s.masterName}                 THEN 1
               WHEN name LIKE ${`${s.masterName}（再）%`}  THEN 2
               WHEN name LIKE ${`${s.masterName}（元）%`}  THEN 2
               ELSE 5
             END AS rank
      FROM dams
      WHERE pref_code = ${s.prefCode}
        AND name LIKE ${`%${s.masterName}%`}
    `;
    const r = chooseRanked(candidates, s.name);
    universe.push({
      externalId: s.name,
      name: s.name,
      prefCode: s.prefCode,
      resolvedDamId: r?.id ?? null,
    });
    if (!r) {
      log(`${SOURCE_ID}: no master match for "${s.name}" (${s.masterName})`);
      continue;
    }
    damByName.set(s.name, r.id);
    await bindExternalId(r.id, SOURCE_ID, s.name);
  }
  await recordUniverse(SOURCE_ID, universe);
  return damByName;
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();
  const damByName = await ensureExternalIds(log);
  log(`${SOURCE_ID}: matched ${damByName.size}/${STATIONS.length} stations to master dams`);

  const r = await fetch(PAGE_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) {
    log(`${SOURCE_ID}: HTTP ${r.status}; aborting`);
    return;
  }
  const { observedAt, rows } = parseAichiYosuiPage(await r.text());
  log(
    `${SOURCE_ID}: parsed ${rows.length} rows, observedAt=${observedAt?.toISOString() ?? '(missing)'}`,
  );
  if (!observedAt) {
    log(`${SOURCE_ID}: no report time found; aborting`);
    return;
  }

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const row of rows) {
    const damId = damByName.get(row.name);
    if (!damId) continue;
    inputs.push({
      observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: row.storageVolumeM3,
      storageRate: row.storageRate,
      inflowM3s: row.inflowM3s,
      outflowM3s: row.outflowM3s,
      waterLevelM: row.waterLevelM,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }
  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: parsed=${rows.length} matched=${damByName.size} written=${written}`);
};

export default task;
