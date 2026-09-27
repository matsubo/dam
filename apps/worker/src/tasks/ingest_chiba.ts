// apps/worker/src/tasks/ingest_chiba.ts
//
// Phase B6 (#10): 千葉県 県内ダムの貯水状況 weekly snapshot.
//
// Source: https://www.pref.chiba.lg.jp/suisei/chosui/chosuijoukyou.html
// Page is updated weekly (Mondays; 更新日 a day or so later) with a static
// HTML table:
//   貯水率（％）| ダム名 | 水道事業者 | 貯水容量(m³) | 貯水量(m³) | 貯水率(%)
// Two tables (水道用 + 工業用水) total ~23 dams across 千葉県 (master has 50).
// The survey date is the table heading 「県内ダム貯水状況（令和X年M月D日現在）」.
// The chart image above the table has its own 「令和X年M月D日9時現在」 alt text,
// which is NOT updated reliably: on 2026-09-27 the page carried 9/14 data
// under a 9/7 alt, and reading the alt stamped the 9/14 figures onto the 9/7
// rows.
//
// We extract one observation per dam at the page's stated timestamp
// (snapped to JST → UTC). No flow / level data on this source, only
// storage volume + rate.
//
// Cron: daily at 02:30 UTC = 11:30 JST. The page changes about once a week
// (sometimes skipping one); polling daily and UPSERTing on the survey date
// picks the update up within a day.

import { type BindableMaster, preferMaster, stampedMaster } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
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

/**
 * The table heading's 「県内ダム貯水状況（令和X年M月D日[H時]現在）」 → UTC.
 * The heading carries no hour; the survey is the 9時 reading, so H defaults
 * to 9 (JST).
 */
export function parseChibaTimestamp(html: string): Date | null {
  const m = html.match(/県内ダム貯水状況（令和(\d+)年(\d{1,2})月(\d{1,2})日(?:(\d{1,2})時)?現在/);
  if (!m) return null;
  // 令和元年 = 2019. 令和X = 2018 + X (令和8 = 2026).
  const yyyy = 2018 + Number(m[1]);
  const hour = m[4] === undefined ? 9 : Number(m[4]);
  return new Date(Date.UTC(yyyy, Number(m[2]) - 1, Number(m[3]), hour - 9, 0, 0, 0));
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
            '千葉県 県内ダムの貯水状況 — weekly 09:00 JST survey (23 ダム; 水道用+工業用水)',
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
  const masters = await sql<BindableMaster[]>`
    SELECT id, name, completed_year AS "completedYear", external_ids->>${SOURCE_ID} AS stamp
    FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing. Keyed by
  // name: one dam can appear in both the 水道用 and 工業用水 tables, and
  // recordUniverse must see each published dam exactly once.
  const universe = new Map<string, UniverseRow>();
  for (const r of rows) {
    const stem = normalizeName(r.pageName);
    if (!stem) continue;
    // A row already stamped with this station keeps it (#57); otherwise the
    // master name normalized the same way, or minus ダム, must equal it.
    let r0 = stampedMaster(masters, r.pageName);
    if (!r0) {
      for (const m of masters) {
        if (normalizeName(m.name) !== stem && m.name.replace(/ダム$/, '') !== r.pageName) continue;
        if (!r0 || preferMaster(m, r0)) r0 = m;
      }
    }
    universe.set(r.pageName, {
      externalId: r.pageName,
      name: r.pageName,
      prefCode: PREF_CODE,
      resolvedDamId: r0?.id ?? null,
    });
    if (!r0) {
      log(`${SOURCE_ID}: no master match for ${r.pageName}`);
      continue;
    }
    out.push({ pageName: r.pageName, damId: r0.id });
    await bindExternalId(r0.id, SOURCE_ID, r.pageName);
  }
  await recordUniverse(SOURCE_ID, [...universe.values()]);
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
