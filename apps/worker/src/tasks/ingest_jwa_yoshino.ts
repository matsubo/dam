// apps/worker/src/tasks/ingest_jwa_yoshino.ts
//
// 水資源機構 吉野川上流総合管理所 — 吉野川水系 5 ダム.
// Real-time page auto-refreshed every 5 minutes; fetched hourly.
//
//   吉野川水系: 池田(徳島) / 早明浦(高知) / 新宮(徳島) / 富郷(愛媛) / 柳瀬(愛媛)
//
// Source: https://www.water.go.jp/mizu/ikeda/mizuinfo/dyn/html/p0001/60/p000101.html
// Format: UTF-8 HTML; "観測日時：YYYY年MM月DD日 HH時MM分" (JST); hourly cadence.
//         貯水位(EL.m)・流入量・全放流量 for all 5 dams.
//         早明浦ダムのみ「利水貯水率[速報値]」もあり (storageRate).
//         "CC" = 閉局 (communication closed); treat as null.
// License: 水資源機構 published; 出典明示で再配布可.
//
// These dams are in jwa-junpo (10-day, priority 290). This adapter upgrades to
// hourly cadence and adds 水位 (EL.m). 早明浦ダムは四国の給水危機指標として最も
// 注目されるダム (Shikoku water-supply crisis indicator).

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const PAGE_URL =
  process.env.JWA_YOSHINO_URL ??
  'https://www.water.go.jp/mizu/ikeda/mizuinfo/dyn/html/p0001/60/p000101.html';

const NAME_MAP: Array<{ yoshinoName: string; masterName: string; prefCodes: string[] }> = [
  { yoshinoName: '池田ダム', masterName: '池田', prefCodes: ['36'] }, // 徳島
  { yoshinoName: '早明浦ダム', masterName: '早明浦', prefCodes: ['39', '36'] }, // 高知
  { yoshinoName: '新宮ダム', masterName: '新宮', prefCodes: ['36', '38'] }, // 徳島
  { yoshinoName: '富郷ダム', masterName: '富郷', prefCodes: ['38'] }, // 愛媛
  { yoshinoName: '柳瀬ダム', masterName: '柳瀬', prefCodes: ['38'] }, // 愛媛
];

interface ParsedRow {
  yoshinoName: string;
  waterLevelM: number | null;
  storageRatePct: number | null; // 早明浦のみ: 利水貯水率[速報値]
  inflowM3s: number | null;
  outflowM3s: number | null;
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
  if (!cleaned || cleaned === '―' || cleaned === '-' || cleaned === '—') return null;
  // CC = 閉局 (station closed); ** = 調整中 (calibrating)
  if (cleaned === 'CC' || cleaned === 'cc' || cleaned === '**') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse JST timestamp from `<span id="data-time">YYYY年MM月DD日 HH時MM分</span>`.
 * Subtract 9 hours to get UTC; JS Date.UTC handles out-of-range hours.
 */
export function parseYoshinoTimestamp(text: string): Date | null {
  const m = text.match(/(\d{4})年(\d{2})月(\d{2})日\s+(\d{1,2})時(\d{2})分/);
  if (!m) return null;
  const yr = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  const hr = Number(m[4]);
  const mi = Number(m[5]);
  const d = new Date(Date.UTC(yr, mo - 1, day, hr - 9, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Extract the HTML section for a specific dam.
 * Dams are wrapped in `<div class="str-data2"...>DAM_NAME</div>`, so we look for
 * `>DAM_NAME</div>` as the section start and the next `str-data2` as the end.
 */
function extractDamSection(html: string, damName: string): string {
  const header = `>${damName}</div>`;
  const start = html.indexOf(header);
  if (start < 0) return '';
  const afterHeader = start + header.length;
  const nextHeader = html.indexOf('class="str-data2"', afterHeader);
  const end = nextHeader > 0 ? nextHeader : html.length;
  return html.slice(start, end);
}

function extractLabeled(section: string, label: string): number | null {
  const labelIdx = section.indexOf(label);
  if (labelIdx < 0) return null;
  const context = textOf(section.slice(labelIdx, labelIdx + 400));
  const afterLabel = context.slice(label.length);
  const m = afterLabel.match(/([\d,]+(?:\.\d+)?)/);
  if (!m) return null;
  return parseNum(m[1] ?? '');
}

export function parseYoshinoHtml(html: string): { observedAt: Date | null; rows: ParsedRow[] } {
  const observedAt = parseYoshinoTimestamp(html);
  const rows: ParsedRow[] = [];

  // 早明浦ダム利水貯水率[速報値] is in the global summary box at the top of the page.
  const sameuraRate = extractLabeled(html, '早明浦ダム利水貯水率[速報値]');

  for (const m of NAME_MAP) {
    const section = extractDamSection(html, m.yoshinoName);
    if (!section) continue;

    const waterLevel = extractLabeled(section, '貯水位');
    const inflow = extractLabeled(section, '流入量');
    // 全放流量 = total outflow (controlled release + spillage)
    const outflow = extractLabeled(section, '全放流量');

    // Skip if water level (primary metric) is unavailable.
    if (waterLevel === null) continue;

    rows.push({
      yoshinoName: m.yoshinoName,
      waterLevelM: waterLevel,
      storageRatePct: m.yoshinoName === '早明浦ダム' ? sameuraRate : null,
      inflowM3s: inflow,
      outflowM3s: outflow,
    });
  }
  return { observedAt, rows };
}

interface DamMatch {
  yoshinoName: string;
  damId: bigint;
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES ('jwa-yoshino', 297,
            '水資源機構 吉野川上流総管 — hourly, 5 dams (池田/早明浦/新宮/富郷/柳瀬)',
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
          WHEN name = ${`${m.masterName}ダム`}       THEN 0
          WHEN name = ${m.masterName}                 THEN 1
          WHEN name LIKE ${`${m.masterName}（再）%`}  THEN 2
          ELSE 5
        END,
        id
      LIMIT 1
    `;
    const r = rows[0];
    universe.push({
      externalId: m.yoshinoName,
      name: m.yoshinoName,
      // A multi-code entry is a LIKE-narrowing hint, not an attribution — its
      // first code is sometimes the wrong prefecture (新宮 is 愛媛, not 徳島),
      // and pref_code is COALESCE-sticky once written.
      prefCode: m.prefCodes.length === 1 ? (m.prefCodes[0] ?? null) : null,
      resolvedDamId: r?.id ?? null,
    });
    if (!r) {
      log(`jwa-yoshino: no master match for "${m.yoshinoName}" (${m.masterName})`);
      continue;
    }
    matches.push({ yoshinoName: m.yoshinoName, damId: r.id });
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object('jwa-yoshino', ${m.yoshinoName}::text)
      WHERE id = ${r.id}
        AND COALESCE(external_ids->>'jwa-yoshino', '') <> ${m.yoshinoName}
    `;
  }
  await recordUniverse('jwa-yoshino', universe);
  return matches;
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();
  const matches = await ensureExternalIds(log);
  log(`jwa-yoshino: matched ${matches.length}/${NAME_MAP.length} master dams`);

  const r = await fetch(PAGE_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) {
    log(`jwa-yoshino: HTTP ${r.status}; aborting`);
    return;
  }
  const html = await r.text();
  const { observedAt, rows: parsed } = parseYoshinoHtml(html);
  log(
    `jwa-yoshino: parsed ${parsed.length} rows, observedAt=${observedAt?.toISOString() ?? '(missing)'}`,
  );

  if (!observedAt) {
    log('jwa-yoshino: no timestamp found; aborting');
    return;
  }

  const matchByName = new Map(matches.map((m) => [m.yoshinoName, m.damId]));
  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const row of parsed) {
    const damId = matchByName.get(row.yoshinoName);
    if (!damId) continue;
    inputs.push({
      observedAt,
      damId,
      sourceId: 'jwa-yoshino',
      storageVolumeM3: null,
      storageRate:
        row.storageRatePct !== null ? Math.max(0, Math.min(1, row.storageRatePct / 100)) : null,
      inflowM3s: row.inflowM3s,
      outflowM3s: row.outflowM3s,
      waterLevelM: row.waterLevelM,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }
  const written = await upsertObservations(inputs);
  log(`jwa-yoshino done: parsed=${parsed.length} matched=${matches.length} written=${written}`);
};

export default task;
