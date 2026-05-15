// apps/worker/src/tasks/ingest_tottori.ts
//
// Seventh real-observation source. 鳥取県ダム諸量情報システム embeds
// every dam's latest values inside the alt attribute of <area> tags on
// the top page (tottoridam.jp/), refreshed every 10 minutes server-side.
// Five prefectural dams covered, hourly cadence per the 計測日時 stamp:
//
//   賀祥 (kasho), 朝鍋 (asanabe), 佐治川 (sajigawa),
//   東郷 (togo),  百谷 (momodani).
//
// Page is EUC-JP encoded; we decode via TextDecoder. The per-area alt
// looks like:
//
//   alt="賀祥ダム
//   計測日時：2026/05/15  22:50
//   時間雨量(mm)： 0
//   累計雨量(mm)： 0
//   ダム水位(m)： 115.86
//   流入量(m3/s)： 0.31
//   放流量(m3/s)： 1.29
//   有効貯水量 (×1000m3)：3136
//   貯水率(%)：47
//   空容量(×1000m3)： 2794"
//
// We parse those KV pairs into one observation per dam per fetch.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import type { Task } from 'graphile-worker';

const PAGE_URL = process.env.TOTTORI_DAM_URL ?? 'http://tottoridam.jp/';

interface DamCfg {
  tottoriName: string;
  masterName: string;
}

const DAMS: DamCfg[] = [
  { tottoriName: '賀祥ダム', masterName: '賀祥' },
  { tottoriName: '朝鍋ダム', masterName: '朝鍋' },
  { tottoriName: '佐治川ダム', masterName: '佐治川' },
  { tottoriName: '東郷ダム', masterName: '東郷' },
  { tottoriName: '百谷ダム', masterName: '百谷' },
];

const PREF_CODE = '31';

interface ParsedRow {
  tottoriName: string;
  observedAt: Date;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  storageVolumeM3: number | null;
  storageRate: number | null;
  rainfallMm: number | null;
}

function parseNum(s: string): number | null {
  const t = s.replace(/[,\s　]/g, '');
  if (!t || t === '―' || t === '-' || t === '欠測') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Parse 「2026/05/15 22:50」 (or 「2026/5/15 23:00」 — Tottori uses both)
 *  as JST → UTC. */
function parseJstStamp(s: string): Date | null {
  const m = s.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0, 0),
  );
}

export function parseTottoriPage(html: string, knownNames: Set<string>): ParsedRow[] {
  const out: ParsedRow[] = [];
  // alt attributes span multiple lines. Match the dam blocks.
  const altRe = /alt="([^"]+ダム)\s*\n([\s\S]*?)"/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
  while ((m = altRe.exec(html)) !== null) {
    const name = m[1] ?? '';
    if (!knownNames.has(name)) continue;
    const body = m[2] ?? '';

    const get = (label: string): string | null => {
      const re = new RegExp(`${label}[（(]?[^：:]*[):)]?\\s*[：:]\\s*([\\-\\d.,]+)`);
      return re.exec(body)?.[1] ?? null;
    };

    const stamp = body.match(/計測日時[：:]\s*([\d/]+\s+\d{1,2}:\d{2})/);
    const observedAt = stamp ? parseJstStamp(stamp[1] ?? '') : null;
    if (!observedAt) continue;

    const level = parseNum(get('ダム水位') ?? '');
    const inflow = parseNum(get('流入量') ?? '');
    const outflow = parseNum(get('放流量') ?? '');
    const volThou = parseNum(get('有効貯水量') ?? '');
    const ratePct = parseNum(get('貯水率') ?? '');
    const rainfall = parseNum(get('時間雨量') ?? '');

    out.push({
      tottoriName: name,
      observedAt,
      waterLevelM: level,
      inflowM3s: inflow,
      outflowM3s: outflow,
      storageVolumeM3: volThou != null ? volThou * 1_000 : null,
      storageRate: ratePct != null ? Math.max(0, Math.min(1, ratePct / 100)) : null,
      rainfallMm: rainfall,
    });
  }
  return out;
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES ('tottori-dam', 307,
            '鳥取県ダム諸量情報システム — hourly, 5 dams (賀祥/朝鍋/佐治川/東郷/百谷)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

interface DamMatch {
  tottoriName: string;
  damId: bigint;
}

async function ensureExternalIds(log: (s: string) => void): Promise<DamMatch[]> {
  const matches: DamMatch[] = [];
  for (const c of DAMS) {
    const rows = await sql<{ id: bigint; name: string }[]>`
      SELECT id, name FROM dams
      WHERE pref_code = ${PREF_CODE}
        AND name LIKE ${`%${c.masterName}%`}
      ORDER BY
        CASE
          WHEN name = ${c.masterName} THEN 0
          WHEN name = ${`${c.masterName}ダム`} THEN 1
          ELSE 5
        END,
        id
      LIMIT 1
    `;
    const r = rows[0];
    if (!r) {
      log(`tottori-dam: no master match for ${c.tottoriName}`);
      continue;
    }
    matches.push({ tottoriName: c.tottoriName, damId: r.id });
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object('tottori-dam', ${c.tottoriName}::text)
      WHERE id = ${r.id}
        AND COALESCE(external_ids->>'tottori-dam', '') <> ${c.tottoriName}
    `;
  }
  return matches;
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();
  const matches = await ensureExternalIds(log);
  log(`tottori-dam: matched ${matches.length}/${DAMS.length} master dams`);

  const r = await fetch(PAGE_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (r.status !== 200) {
    log(`tottori-dam: HTTP ${r.status}; aborting`);
    return;
  }
  // Page is EUC-JP — decode explicitly.
  const buf = await r.arrayBuffer();
  const html = new TextDecoder('euc-jp').decode(buf);
  const parsed = parseTottoriPage(html, new Set(DAMS.map((d) => d.tottoriName)));
  log(`tottori-dam: parsed ${parsed.length} dam rows`);

  const matchByName = new Map(matches.map((m) => [m.tottoriName, m.damId]));
  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const row of parsed) {
    const damId = matchByName.get(row.tottoriName);
    if (!damId) continue;
    inputs.push({
      observedAt: row.observedAt,
      damId,
      sourceId: 'tottori-dam',
      storageVolumeM3: row.storageVolumeM3,
      storageRate: row.storageRate,
      inflowM3s: row.inflowM3s,
      outflowM3s: row.outflowM3s,
      waterLevelM: row.waterLevelM,
      rainfallMm: row.rainfallMm,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }
  const written = await upsertObservations(inputs);
  log(`tottori-dam done: parsed=${parsed.length} matched=${matches.length} written=${written}`);
};

export default task;
