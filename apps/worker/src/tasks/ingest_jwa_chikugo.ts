// apps/worker/src/tasks/ingest_jwa_chikugo.ts
//
// Fourth real-observation source. 水資源機構 筑後川ダム統合管理事務所
// publishes a daily-updated 0時 reading for the 筑後川 system dams:
//
//   松原 (国交省), 下筌 (国交省), 大山 (JWA), 合所 (福岡県),
//   江川 (JWA), 寺内 (JWA), 小石原川 (JWA) — 7 dams total.
//
// 大山 / 江川 / 寺内 / 小石原川 overlap with jwa-junpo but here we get
// DAILY cadence (vs 10-day). 松原 / 下筌 / 合所 are NEW vs all prior
// sources.
//
// Source: https://www.water.go.jp/chikugo/chikugo/water-source.html
// Format: static HTML; two block patterns:
//   (A) <div class="ws_title">{name}ダム</div>
//       <div class="storage_rate">■貯水率　<span>NN.N%</span></div>
//       <div class="ws_data"><table>...<td>NN千m³</td>...</table></div>
//   (B) Inside the 「3ダム合計」 box, three <div class="sandam_title">
//       blocks with a single-row <table> carrying 貯水率 / 貯水位 / 貯水量.
// License: 水資源機構 published; 出典明示で再配布可.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { type UniverseRow, recordUniverse } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const PAGE_URL =
  process.env.JWA_CHIKUGO_URL ?? 'https://www.water.go.jp/chikugo/chikugo/water-source.html';

const NAME_MAP: Array<{ chikugoName: string; masterName: string; prefCodes: string[] }> = [
  // Pattern-A blocks (top-level ws_box):
  { chikugoName: '松原ダム', masterName: '松原', prefCodes: ['44'] }, // 大分
  { chikugoName: '下筌ダム', masterName: '下筌', prefCodes: ['43', '44'] }, // 熊本/大分
  { chikugoName: '大山ダム', masterName: '大山', prefCodes: ['44'] },
  { chikugoName: '合所ダム', masterName: '合所', prefCodes: ['40'] }, // 福岡
  // Pattern-B blocks (inside 3ダム合計):
  { chikugoName: '江川ダム', masterName: '江川', prefCodes: ['40'] },
  { chikugoName: '寺内ダム', masterName: '寺内', prefCodes: ['40'] },
  { chikugoName: '小石原川ダム', masterName: '小石原川', prefCodes: ['40'] },
];

interface ParsedRow {
  chikugoName: string;
  storageRatePct: number;
  storageVolumeThouM3: number;
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
  const cleaned = s.replace(/[,\s　%千m³]/g, '');
  if (!cleaned || cleaned === '―' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function parseJwaChikugoHtml(html: string): ParsedRow[] {
  const out: ParsedRow[] = [];
  const knownNames = new Set(NAME_MAP.map((m) => m.chikugoName));

  // Pattern A: each ws_box that has ws_title + storage_rate + ws_data.
  // The regex captures the title, the rate div, and the data table block;
  // we then pluck dam name from title (strip everything after the first
  // 「ダム」, then add 「ダム」 back) and pull the numbers out.
  const aRe =
    /<div class="ws_title">([^<]+)<[\s\S]*?<div class="storage_rate">[\s\S]*?<span[^>]*><!--\([^)]*\)-->\s*([\d.]+)%[\s\S]*?<div class="ws_data">([\s\S]*?)<\/div>/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
  while ((m = aRe.exec(html)) !== null) {
    const rawTitle = textOf(m[1] ?? '');
    const ratePct = Number(m[2]);
    const dataBlock = m[3] ?? '';
    // Title is e.g. "松原ダム（国交省）０時" — extract up to ダム inclusive.
    const nameMatch = rawTitle.match(/^[^（(\s]+ダム/);
    const name = nameMatch?.[0];
    if (!name || !knownNames.has(name)) continue;
    if (!Number.isFinite(ratePct)) continue;
    // 貯水量 from the data block — first 千m³ number inside a <td>.
    const volMatch = dataBlock.match(/<td[^>]*>[\s\S]*?<!--\([^)]*\)-->\s*([\d,]+)千m/);
    const vol = volMatch ? parseNum(volMatch[1] ?? '') : null;
    if (vol == null) continue;
    out.push({ chikugoName: name, storageRatePct: ratePct, storageVolumeThouM3: vol });
  }

  // Pattern B: each sandam_title followed by a <table> with one tbody row
  // of three <td>s (rate / level / volume).
  const bRe =
    /<div class="sandam_title">([^<]+)<\/div>[\s\S]*?<tbody>[\s\S]*?<tr>\s*<td[^>]*>[\s\S]*?<!--\([^)]*\)-->\s*([\d.]+)%[\s\S]*?<td[^>]*>[\s\S]*?<\/td>\s*<td[^>]*>[\s\S]*?<!--\([^)]*\)-->\s*([\d,]+)千m/g;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
  while ((m = bRe.exec(html)) !== null) {
    const rawTitle = textOf(m[1] ?? '');
    const ratePct = Number(m[2]);
    const vol = parseNum(m[3] ?? '');
    const nameMatch = rawTitle.match(/^[^（(\s]+ダム/);
    const name = nameMatch?.[0];
    if (!name || !knownNames.has(name)) continue;
    if (!Number.isFinite(ratePct) || vol == null) continue;
    // Skip if pattern-A already produced this row (shouldn't happen, but be safe).
    if (out.some((r) => r.chikugoName === name)) continue;
    out.push({ chikugoName: name, storageRatePct: ratePct, storageVolumeThouM3: vol });
  }

  return out;
}

interface DamMatch {
  chikugoName: string;
  damId: bigint;
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES ('jwa-chikugo', 297,
            '水資源機構 筑後川ダム統合管理事務所 — daily 0時, 7 dams',
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
          ELSE 5
        END,
        id
      LIMIT 1
    `;
    const r = rows[0];
    universe.push({
      externalId: m.chikugoName,
      name: m.chikugoName,
      // A multi-code entry (下筌 is on the 熊本/大分 border) is a
      // LIKE-narrowing hint, not an attribution, and pref_code is
      // COALESCE-sticky once written.
      prefCode: m.prefCodes.length === 1 ? (m.prefCodes[0] ?? null) : null,
      resolvedDamId: r?.id ?? null,
    });
    if (!r) {
      log(`jwa-chikugo: no master match for "${m.chikugoName}" (${m.masterName})`);
      continue;
    }
    matches.push({ chikugoName: m.chikugoName, damId: r.id });
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object('jwa-chikugo', ${m.chikugoName}::text)
      WHERE id = ${r.id}
        AND COALESCE(external_ids->>'jwa-chikugo', '') <> ${m.chikugoName}
    `;
  }
  await recordUniverse('jwa-chikugo', universe);
  return matches;
}

/** Compute today's JST midnight as the observed_at (the page header is 0時 JST). */
function todayJstMidnight(now = new Date()): Date {
  const utcDate = now.getUTCDate();
  // JST midnight = previous-UTC-date 15:00.
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), utcDate - 1, 15, 0, 0, 0));
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();
  const matches = await ensureExternalIds(log);
  log(`jwa-chikugo: matched ${matches.length}/${NAME_MAP.length} master dams`);

  const r = await fetch(PAGE_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) {
    log(`jwa-chikugo: HTTP ${r.status}; aborting`);
    return;
  }
  const html = await r.text();
  const parsed = parseJwaChikugoHtml(html);
  log(`jwa-chikugo: parsed ${parsed.length} dam rows`);

  const observedAt = todayJstMidnight();
  const matchByName = new Map(matches.map((m) => [m.chikugoName, m.damId]));
  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const row of parsed) {
    const damId = matchByName.get(row.chikugoName);
    if (!damId) continue;
    inputs.push({
      observedAt,
      damId,
      sourceId: 'jwa-chikugo',
      storageVolumeM3: row.storageVolumeThouM3 * 1_000,
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
  log(`jwa-chikugo done: parsed=${parsed.length} matched=${matches.length} written=${written}`);
};

export default task;
