// apps/worker/src/tasks/ingest_jwa_kiso_rt.ts
//
// 水資源機構 中部支社 木曽川水系 — real-time data for 6 dams.
// Updated every ~10 minutes; one page fetched hourly.
//
//   木曽川水系: 牧尾 (長野) / 味噌川 (長野) / 阿木川 (岐阜) / 岩屋 (岐阜)
//              徳山 (岐阜) / 中里貯水池 (三重, 三重用水 — いなべ市)
//
// Source: https://www.water.go.jp/mizu/chubu/realtime/index.html
// Format: Static HTML with <h4>-delimited blocks; "観測時刻：YYYY年MM月DD日 HH時MM分" (JST).
//         Storage in 10³m³ (= 千m³); stored as m³ after × 1000.  Water level in EL.m.
//         "cc" = sensor communication cut; treat as null.
// License: 水資源機構「著作権・リンク等について」(honsya/honsya/policy/copyright):
//         「数値データ、簡単な表・グラフ等は著作権の対象ではありませんので、これらに
//         ついては本利用ルールの適用はなく、自由に利用できます。」 The 中部支社
//         リアルタイム情報 note (mizu/chubu/res/description/description.pdf) asks:
//         「ツール等による、自動的なデータ収集等はサーバに負荷がかかり、情報提供
//         できなくなる恐れがありますのでご遠慮頂くよう、ご理解・ご協力をお願い
//         いたします。」 Kept on that basis (user decision, 2026-09-28): only the
//         observed numbers are stored, with the source named, and the fetch is one
//         page an hour (the page itself refreshes every 10 minutes).
//
// Upgrades jwa-chubu (daily, priority 296) to hourly cadence.
// Priority 297 > 296 so this becomes preferredSource for all 6 dams.

import { type BindableMaster, chooseRanked } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const PAGE_URL =
  process.env.JWA_KISO_RT_URL ?? 'https://www.water.go.jp/mizu/chubu/realtime/index.html';

const NAME_MAP: Array<{ kisoName: string; masterName: string; prefCodes: string[] }> = [
  { kisoName: '牧尾ダム', masterName: '牧尾', prefCodes: ['20'] }, // 長野
  { kisoName: '味噌川ダム', masterName: '味噌川', prefCodes: ['20'] },
  { kisoName: '阿木川ダム', masterName: '阿木川', prefCodes: ['21'] }, // 岐阜
  { kisoName: '岩屋ダム', masterName: '岩屋', prefCodes: ['21'] },
  { kisoName: '徳山ダム', masterName: '徳山', prefCodes: ['21'] },
  { kisoName: '中里貯水池', masterName: '中里', prefCodes: ['24'] }, // 三重 (三重用水)
];

interface ParsedRow {
  kisoName: string;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
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
export function parseKisoRtTimestamp(text: string): Date | null {
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

// A dam's section is its own table: the page goes on after 中里貯水池 with
// unmapped blocks (調整池, 長良川河口堰, 木曽川大堰) whose rows share its labels.
function extractSection(html: string, damName: string): string {
  const start = html.indexOf(`<h4>${damName}</h4>`);
  if (start < 0) return '';
  const end = html.indexOf('</table>', start);
  return html.slice(start, end < 0 ? html.length : end);
}

// Extract the first text node of the <td class="data"> following <th>LABEL</th>.
// An empty cell yields null; it must not fall through to the next row's value.
// Using a regex on the raw HTML avoids conflating the value with the superscript
// unit text (e.g. 10³m³ rendered as "103m3" when stripped of tags).
function extractLabeledValue(section: string, label: string): number | null {
  const pos = section.indexOf(`${label}</th>`);
  if (pos < 0) return null;
  const after = section.slice(pos);
  const m = after.match(/<td[^>]*class="data"[^>]*>([^<]*)/);
  if (!m) return null;
  return parseNum((m[1] ?? '').trim());
}

export function parseKisoRtHtml(html: string): { observedAt: Date | null; rows: ParsedRow[] } {
  const observedAt = parseKisoRtTimestamp(html);
  const rows: ParsedRow[] = [];

  for (const m of NAME_MAP) {
    const section = extractSection(html, m.kisoName);
    if (!section) continue;

    const waterLevel = extractLabeledValue(section, '貯水位');
    const storageThou = extractLabeledValue(section, '有効貯水量');
    const inflow = extractLabeledValue(section, '流入量');
    const outflow = extractLabeledValue(section, '放流量');

    // Skip if both primary metrics are unavailable (full cc outage).
    if (waterLevel === null && storageThou === null) continue;

    rows.push({
      kisoName: m.kisoName,
      waterLevelM: waterLevel,
      storageVolumeM3: storageThou !== null ? storageThou * 1000 : null,
      inflowM3s: inflow,
      outflowM3s: outflow,
    });
  }
  return { observedAt, rows };
}

interface DamMatch {
  kisoName: string;
  damId: bigint;
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES ('jwa-kiso-rt', 297,
            '水資源機構 中部支社 木曽川水系 実時計 — hourly, 6 dams (牧尾/阿木川/味噌川/岩屋/中里/徳山)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

export async function ensureExternalIds(log: (s: string) => void): Promise<DamMatch[]> {
  const matches: DamMatch[] = [];
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];
  for (const m of NAME_MAP) {
    // （元） and （再） rank alike so chooseRanked binds the current twin.
    const candidates = await sql<(BindableMaster & { rank: number })[]>`
      SELECT id, name, completed_year AS "completedYear",
             external_ids->>'jwa-kiso-rt' AS stamp,
             CASE
               WHEN name = ${`${m.masterName}ダム`}      THEN 0
               WHEN name = ${`${m.masterName}貯水池`}     THEN 1
               WHEN name = ${m.masterName}                THEN 2
               WHEN name LIKE ${`${m.masterName}（再）%`} THEN 3
               WHEN name LIKE ${`${m.masterName}（元）%`} THEN 3
               ELSE 5
             END AS rank
      FROM dams
      WHERE pref_code = ANY(${m.prefCodes}::text[])
        AND name LIKE ${`%${m.masterName}%`}
    `;
    const r = chooseRanked(candidates, m.kisoName);
    universe.push({
      externalId: m.kisoName,
      name: m.kisoName,
      prefCode: m.prefCodes[0] ?? null,
      resolvedDamId: r?.id ?? null,
    });
    if (!r) {
      log(`jwa-kiso-rt: no master match for "${m.kisoName}" (${m.masterName})`);
      continue;
    }
    matches.push({ kisoName: m.kisoName, damId: r.id });
    await bindExternalId(r.id, 'jwa-kiso-rt', m.kisoName);
  }
  await recordUniverse('jwa-kiso-rt', universe);
  return matches;
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();
  const matches = await ensureExternalIds(log);
  log(`jwa-kiso-rt: matched ${matches.length}/${NAME_MAP.length} master dams`);

  const r = await fetch(PAGE_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) {
    log(`jwa-kiso-rt: HTTP ${r.status}; aborting`);
    return;
  }
  const html = await r.text();
  const { observedAt, rows: parsed } = parseKisoRtHtml(html);
  log(
    `jwa-kiso-rt: parsed ${parsed.length} rows, observedAt=${observedAt?.toISOString() ?? '(missing)'}`,
  );

  if (!observedAt) {
    log('jwa-kiso-rt: no timestamp found; aborting');
    return;
  }

  const matchByName = new Map(matches.map((m) => [m.kisoName, m.damId]));
  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const row of parsed) {
    const damId = matchByName.get(row.kisoName);
    if (!damId) continue;
    inputs.push({
      observedAt,
      damId,
      sourceId: 'jwa-kiso-rt',
      storageVolumeM3: row.storageVolumeM3,
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
  log(`jwa-kiso-rt done: parsed=${parsed.length} matched=${matches.length} written=${written}`);
};

export default task;
