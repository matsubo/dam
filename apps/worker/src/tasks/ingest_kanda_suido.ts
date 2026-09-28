// apps/worker/src/tasks/ingest_kanda_suido.ts
//
// 苅田町水道課「水道の安定供給と安全性」 — 水源の状況 of the town's three sources,
// daily.
//
// Source: https://www.town.kanda.lg.jp/page/2021.html. 表1 (UTF-8 CMS table):
//   貯水池 | 有効貯水量 | 貯水量 | 貯水率％ | 前年同日貯水量   (volumes 千立方メートル)
// for 油木ダム / 山口ダム / 井ノ口池, closed by a row 「令和 8年 9月 28日現在」
// (date only: stamped 00:00 JST). The page's 更新日 moved with the date on the
// capture (both 2026-09-28).
//
// 山口ダム → 山口 (NDI 2248) by pin: pref 40 also has 山口調整池 (NDI 2487,
// 筑紫野市), which is locally called 山口ダム too. The town's 山口ダム feeds its
// 二崎浄水場 (same page: 「原水は油木ダム系今川と、山口ダムより取水」), i.e. the
// 福岡県 dam in 苅田町 whose master 有効 736,000 m³ is the page's 有効貯水量 736.
// 油木ダム is the 福岡県 dam kasenbosai and kitakyushu-suido also carry.
// 井ノ口池 (南原浄水場's source, 220 千m³) is not in the NDI master: recorded
// unresolved, with a not_dam_reason from migration 0219.
//
// Rate: 貯水量 / 有効貯水量 as printed. 山口 633 / 85.9 % = 737 千m³ (master 有効
// 736); 油木 6,463 / 44.7 % = 14,459 against a printed 14,450, the 洪水期
// (6/1–10/20) 利水容量 福岡県 lists for 油木 — below the master's annual 17,450.
// Trusted in 0219.
//
// Priority 293: the only source for 山口; for 油木 below kasenbosai (310) and
// kitakyushu-suido (300), above kyushu-nousei (279).
// Cron daily 06:13 UTC (15:13 JST).

import { type BindableMaster, stampedMaster } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const PAGE_URL = process.env.KANDA_SUIDO_URL ?? 'https://www.town.kanda.lg.jp/page/2021.html';

const PREF_CODE = '40';
const SOURCE_ID = 'kanda-suido';

/** Page names the name rule would bind wrongly, pinned by NDI (see header). */
const NDI_PINS: Readonly<Record<string, string>> = {
  山口ダム: '2248',
};

// --- parsing ----------------------------------------------------------------

export interface ParsedRow {
  /** 貯水池 as printed ("山口ダム"); also the stamp and universe key. */
  name: string;
  /** 有効貯水量 (m³), the figure the rate divides by. */
  capacityM3: number | null;
  storageVolumeM3: number | null;
  /** 貯水率 as a 0..1 fraction. */
  storageRate: number | null;
}

export interface ParsedPage {
  /** The 「…現在」 date at 00:00 JST, or null if the line is missing. */
  observedAt: Date | null;
  rows: ParsedRow[];
}

/** Tag-free, NFKC-folded, whitespace-free text. */
function flat(cell: string): string {
  return cell
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, '')
    .normalize('NFKC')
    .replace(/\s+/g, '');
}

/** "6,463千立方メートル" / "44.7%" → number; anything else → null. */
function num(cell: string | undefined): number | null {
  const m = flat(cell ?? '')
    .replace(/,/g, '')
    .match(/^(\d+(?:\.\d+)?)(?:千立方メートル|%)?$/);
  return m ? Number(m[1]) : null;
}

export function parseKandaSuigen(html: string): ParsedPage {
  const start = html.indexOf('<caption>表1</caption>');
  const body = start >= 0 ? html.slice(start) : '';
  const table = body.slice(0, body.indexOf('</table>'));

  const rows: ParsedRow[] = [];
  for (const tr of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...(tr[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
    if (cells.length !== 5) continue;
    const name = flat(cells[0] ?? '');
    if (!name) continue;
    const capacity = num(cells[1]);
    const volume = num(cells[2]);
    const rate = num(cells[3]);
    rows.push({
      name,
      capacityM3: capacity === null ? null : capacity * 1000,
      storageVolumeM3: volume === null ? null : volume * 1000,
      storageRate: rate === null ? null : rate / 100,
    });
  }

  const d = flat(table).match(/令和(元|\d+)年(\d{1,2})月(\d{1,2})日現在/);
  const observedAt = d
    ? new Date(
        Date.UTC(2018 + (d[1] === '元' ? 1 : Number(d[1])), Number(d[2]) - 1, Number(d[3]), -9),
      )
    : null;
  return { observedAt, rows };
}

// --- matching ---------------------------------------------------------------

export interface KandaMaster extends BindableMaster {
  ndi: string | null;
}

/** The NDI pin, else the stamped row, else the one master row named like the page's ダム. */
export function chooseMaster(name: string, masters: KandaMaster[]): bigint | null {
  const pin = NDI_PINS[name];
  if (pin) return masters.find((m) => m.ndi === pin)?.id ?? null;
  const stamped = stampedMaster(masters, name);
  if (stamped) return stamped.id;
  const stem = name.replace(/ダム$/, '');
  const hits = masters.filter((m) => m.name.normalize('NFKC') === stem);
  return hits.length === 1 ? (hits[0]?.id ?? null) : null;
}

export interface KandaPlan {
  universe: UniverseRow[];
  writes: { damId: bigint; row: ParsedRow }[];
}

/** The whole list for the universe; readings for every matched row that has one. */
export function planKanda(rows: ParsedRow[], masters: KandaMaster[]): KandaPlan {
  const universe: UniverseRow[] = [];
  const writes: KandaPlan['writes'] = [];
  for (const row of rows) {
    const damId = chooseMaster(row.name, masters);
    const hasValue = row.storageVolumeM3 !== null || row.storageRate !== null;
    universe.push({
      externalId: row.name,
      name: row.name,
      prefCode: PREF_CODE,
      resolvedDamId: damId,
      hasData: hasValue ? true : null,
    });
    if (damId && hasValue) writes.push({ damId, row });
  }
  return { universe, writes };
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 293,
            '苅田町水道課 水源の状況 — 油木/山口 (日次, 貯水量+貯水率)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

// --- task -------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

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

  const { observedAt, rows } = parseKandaSuigen(await r.text());
  log(`${SOURCE_ID}: parsed ${rows.length} rows, 現在 ${observedAt?.toISOString() ?? 'missing'}`);
  if (!observedAt || rows.length === 0) {
    throw new Error(
      `${SOURCE_ID}: ${rows.length} rows / date ${observedAt ? 'found' : 'missing'} on ${PAGE_URL} — layout change?`,
    );
  }

  const masters = await sql<KandaMaster[]>`
    SELECT id, name, completed_year AS "completedYear", external_ids->>'ndi' AS ndi,
           external_ids->>${SOURCE_ID} AS stamp
    FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const plan = planKanda(rows, masters);
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  await recordUniverse(SOURCE_ID, plan.universe);
  for (const u of plan.universe) {
    if (!u.resolvedDamId) log(`${SOURCE_ID}: no master match for "${u.name}"`);
  }
  for (const w of plan.writes) await bindExternalId(w.damId, SOURCE_ID, w.row.name);

  const written = await upsertObservations(
    plan.writes.map(({ damId, row }) => ({
      observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: row.storageVolumeM3,
      storageRate: row.storageRate,
      inflowM3s: null,
      outflowM3s: null,
      waterLevelM: null,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    })),
  );
  log(
    `${SOURCE_ID} done: parsed=${rows.length} matched=${plan.universe.filter((u) => u.resolvedDamId).length} written=${written}`,
  );
};

export default task;
