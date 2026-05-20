// apps/worker/src/tasks/ingest_chiba.ts
//
// Phase B6 (#10): 千葉県 県内ダムの貯水状況 daily snapshot.
//
// Source: https://www.pref.chiba.lg.jp/suisei/chosui/chosuijoukyou.html
// Page is updated each morning around 9:00 JST with a static HTML table:
//   貯水率（％）| ダム名 | 水道事業者 | 貯水容量(m³) | 貯水量(m³) | 貯水率(%)
// Two tables (水道用 + 工業用水) total ~23 dams across 千葉県 (master has 50).
// Page header carries 「令和X年M月D日H時現在」 timestamp.
//
// We extract one observation per dam at the page's stated timestamp
// (snapped to JST → UTC). No flow / level data on this source, only
// storage volume + rate.
//
// Cron: daily at 02:00 UTC = 11:00 JST (gives upstream 2h headroom after
// its 9 AM publish).

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import type { Task } from 'graphile-worker';

const PAGE_URL =
  process.env.CHIBA_DAM_URL ?? 'https://www.pref.chiba.lg.jp/suisei/chosui/chosuijoukyou.html';

const PREF_CODE = '12';
const SOURCE_ID = 'chiba-suisei';

interface ParsedRow {
  pageName: string;
  storageVolumeM3: number | null;
  storageRate: number | null;
}

function parseNum(s: string): number | null {
  const t = s.replace(/[,\s　]/g, '');
  if (!t || t === '-' || t === '−' || t === '欠測') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Map "令和X(YYYY)年M月D日H時" or "令和X年M月D日H時" → UTC Date snapped to H:00 JST. */
export function parseChibaTimestamp(html: string): Date | null {
  // Prefer the in-body 「令和X年M月D日H時現在」 line over the header 更新日.
  const m = html.match(/令和(\d+)年(\d{1,2})月(\d{1,2})日(\d{1,2})時/);
  if (!m) return null;
  // 令和元年 = 2019. 令和X = 2018 + X (令和8 = 2026).
  const reiwa = Number(m[1]);
  const yyyy = 2018 + reiwa;
  return new Date(Date.UTC(yyyy, Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, 0, 0, 0));
}

/** Normalize 一/二 → 1/2 and strip "ダム" suffix to compare against master.name. */
function normalizeName(s: string): string {
  return s.replace(/ダム$/, '').replace(/一/g, '1').replace(/二/g, '2').replace(/三/g, '3').trim();
}

/**
 * Parse the Chiba page HTML. Skips subtotal rows where the No column is "-".
 */
export function parseChibaPage(html: string): ParsedRow[] {
  const cells = Array.from(html.matchAll(/<td[^>]*>([^<]{0,40})<\/td>/g)).map((m) =>
    (m[1] ?? '').trim(),
  );
  const out: ParsedRow[] = [];
  for (let i = 0; i + 5 < cells.length; i += 6) {
    const no = cells[i] ?? '';
    const name = cells[i + 1] ?? '';
    const op = cells[i + 2] ?? '';
    const capStr = cells[i + 3] ?? '';
    const volStr = cells[i + 4] ?? '';
    const rateStr = cells[i + 5] ?? '';
    if (!no || no === '-' || /小計/.test(op) || /小計/.test(name)) continue;
    if (!/^\d+$/.test(no)) continue;
    const vol = parseNum(volStr);
    const rate = parseNum(rateStr);
    out.push({
      pageName: name,
      storageVolumeM3: vol,
      storageRate: rate != null ? rate / 100 : null,
    });
    // capStr currently unused — could be stored as design capacity in future.
    void capStr;
  }
  return out;
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 290,
            '千葉県 県内ダムの貯水状況 — daily 09:00 JST snapshot (23 ダム; 水道用+工業用水)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

interface DamMatch {
  pageName: string;
  damId: bigint;
}

async function matchMaster(rows: ParsedRow[], log: (s: string) => void): Promise<DamMatch[]> {
  const out: DamMatch[] = [];
  for (const r of rows) {
    const stem = normalizeName(r.pageName);
    if (!stem) continue;
    // Match against master, normalizing the master name the same way.
    const cands = await sql<{ id: bigint; name: string }[]>`
      SELECT id, name FROM dams
      WHERE pref_code = ${PREF_CODE}
        AND (
          REPLACE(REPLACE(REPLACE(REGEXP_REPLACE(name, 'ダム$', ''), '一', '1'), '二', '2'), '三', '3') = ${stem}
          OR REGEXP_REPLACE(name, 'ダム$', '') = ${r.pageName}
        )
      ORDER BY id
      LIMIT 1
    `;
    const r0 = cands[0];
    if (!r0) {
      log(`${SOURCE_ID}: no master match for ${r.pageName}`);
      continue;
    }
    out.push({ pageName: r.pageName, damId: r0.id });
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object(${SOURCE_ID}, ${r.pageName}::text)
      WHERE id = ${r0.id}
        AND COALESCE(external_ids->>${SOURCE_ID}, '') <> ${r.pageName}
    `;
  }
  return out;
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const ua =
    process.env.HTTP_USER_AGENT ??
    'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

  const r = await fetch(PAGE_URL, {
    headers: { 'user-agent': ua },
    signal: AbortSignal.timeout(15_000),
  });
  if (r.status !== 200) {
    log(`${SOURCE_ID}: HTTP ${r.status}; abort`);
    return;
  }
  const html = await r.text();
  const observedAt = parseChibaTimestamp(html);
  if (!observedAt) {
    log(`${SOURCE_ID}: could not parse page timestamp`);
    return;
  }
  const parsed = parseChibaPage(html);
  log(`${SOURCE_ID}: parsed ${parsed.length} dams at ${observedAt.toISOString()}`);

  const matches = await matchMaster(parsed, log);
  const matchByName = new Map(matches.map((m) => [m.pageName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of parsed) {
    const damId = matchByName.get(p.pageName);
    if (!damId) continue;
    if (p.storageVolumeM3 == null && p.storageRate == null) continue;
    inputs.push({
      observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: p.storageVolumeM3,
      storageRate: p.storageRate,
      inflowM3s: null,
      outflowM3s: null,
      waterLevelM: null,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }
  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: parsed=${parsed.length} matched=${matches.length} written=${written}`);
};

export default task;
