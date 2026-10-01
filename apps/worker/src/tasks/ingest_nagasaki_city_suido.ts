// apps/worker/src/tasks/ingest_nagasaki_city_suido.ts
//
// 長崎市上下水道局 浄水課「長崎市ダム貯水量一覧表」 — the city's 13 水源ダム, weekly.
//
// Source: https://www.city.nagasaki.lg.jp/page/53407.html. One CMS-rendered
// UTF-8 table under a 「令和8年8月24日現在、長崎市の平均貯水率は…」 line:
//   ダム種別 | 浄水場名 | ダム名 | 水道有効量(m³) | 今週の貯水状況 貯水量(m³) | 貯水率(%)
// with rowspan'd 種別/浄水場 cells and 小計/計/合計 rows in between. The 現在
// date is a Monday (Wayback snapshots 2025-05 … 2026-02 and the live page all
// read 月曜 現在, 更新日 the next day); no time of day is printed, so the table
// is stamped 00:00 JST. The keywords meta keeps a stale 「令和6年11月4日現在」,
// so the date is read from the body only. Updates lapse at times (live page on
// 2026-09-28 still showed 8月24日), so a stale page just re-upserts the same row.
//
// Written: 浦上 only. It is the one city dam no other source carries (it is
// not in 長崎県河川砂防情報's dam_m.json and has no kasenbosai station). The
// other rows are recorded in the universe only: they are covered by
// kasenbosai / nagasaki-kasen, and their 水道有効量 is the city's 水道 share of
// a multipurpose dam (西山 760,000 vs 有効 1,470,000; 中尾 1,000,000 vs
// 1,470,000), so their 貯水率 is on a basis the master does not have. 落矢 is
// 休止中 (no readings).
//
// Rate: 浦上 1,812,000 / 95.3 % = 1,901 千m³ against 浦上（元）'s 有効 1,900,000,
// the master's static denominator — not marked trusted (0048's okinawa-eb
// reasoning, as matsue-suido).
//
// Priority 293: nothing else publishes 浦上. Cron daily 06:52 UTC (15:52 JST),
// after the Tuesday update.

import { type BindableMaster, preferMaster, stampedMaster } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const PAGE_URL =
  process.env.NAGASAKI_CITY_SUIDO_URL ?? 'https://www.city.nagasaki.lg.jp/page/53407.html';

const PREF_CODE = '42';
const SOURCE_ID = 'nagasaki-city-suido';

/**
 * Page names the name rule binds wrongly, pinned to an NDI row.
 *
 * 浦上 → 浦上（元） (NDI 2602). 長崎県's 長崎水害緊急ダム建設事業 is still
 * rebuilding it: 「浦上ダムにおいては、３０ｃｍのダムかさ上げと約４８万㎥の
 * 貯水池掘削を計画しており、現在は貯水池掘削に向けた仮設ヤードの造成を進捗中」,
 * 建設期間 昭和５８年度～令和１１年度（予定）, 利水容量 190.0万m³ today and about
 * 120万m³ after (長崎県 河川課 事業概要, pref.nagasaki.jp/uploads/2025/06/
 * 1750295551.pdf p.35-36; 「仮設ヤードの造成工事を行っています」 on
 * pref.nagasaki.jp/doc/page-689561.html, 2026-03-12). The page's 水道有効量
 * 1,900,000 is the （元）'s 有効 exactly; the （再） (NDI 2601) is the planned
 * 2,330,000 dam. Pinned rather than left to the twin rule so a completion year
 * the master refresh might write for the （再） cannot move 浦上 before the city
 * does; WRITE below stops the run if the page's 水道有効量 moves off 1,900,000.
 *
 * 小ケ倉 → 小ヶ倉 (NDI 2609), the 長崎市上戸町 dam of the 小ケ倉浄水場 — pref 42
 * has a second 小ヶ倉 (NDI 2592, 諌早市小ヶ倉町).
 */
const NDI_PINS: Readonly<Record<string, string>> = {
  浦上: '2602',
  小ケ倉: '2609',
};

/** Rows whose readings are written, with the 水道有効量 their binding assumes. */
const WRITE: Readonly<Record<string, { capacityM3: number }>> = {
  浦上: { capacityM3: 1_900_000 },
};

// --- parsing ----------------------------------------------------------------

export interface ParsedRow {
  /** ダム名 as printed ("浦上"); also the stamp and universe key. */
  name: string;
  /** 水道有効量 (m³); null for 休止中. */
  capacityM3: number | null;
  storageVolumeM3: number | null;
  /** 貯水率 as a 0..1 fraction. */
  storageRate: number | null;
  /** The city prints 休止中 for the dam: it publishes no readings for it. */
  suspended: boolean;
}

export interface ParsedPage {
  /** The 「…現在」 date at 00:00 JST, or null if the line is missing. */
  observedAt: Date | null;
  rows: ParsedRow[];
}

/** Tag-free, NFKC-folded (full-width digits → ASCII), whitespace-free text. */
function flat(cell: string): string {
  return cell
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, '')
    .normalize('NFKC')
    .replace(/\s+/g, '');
}

function num(cell: string | undefined): number | null {
  const t = flat(cell ?? '').replace(/,/g, '');
  if (!/^\d+(?:\.\d+)?$/.test(t)) return null;
  return Number(t);
}

const TOTAL_ROWS: Readonly<Record<string, true>> = { 計: true, 小計: true, 合計: true };

export function parseNagasakiDamList(html: string): ParsedPage {
  // The body starts at main_body; the <head> keywords meta has a stale date.
  const start = html.indexOf('id="main_body"');
  const body = start >= 0 ? html.slice(start) : html;

  const d = flat(body).match(/令和(元|\d+)年(\d{1,2})月(\d{1,2})日現在/);
  const observedAt = d
    ? new Date(
        Date.UTC(2018 + (d[1] === '元' ? 1 : Number(d[1])), Number(d[2]) - 1, Number(d[3]), -9),
      )
    : null;

  const rows: ParsedRow[] = [];
  const table = body.match(/<table[^>]*>([\s\S]*?)<\/table>/)?.[1] ?? '';
  for (const tr of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    // Rowspan'd 種別/浄水場 cells only lead the first row of their group, so
    // the columns are taken from the right: …, ダム名, 有効量, 貯水量, 貯水率.
    const cells = [...(tr[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
    if (cells.length < 4) continue;
    const name = flat(cells[cells.length - 4] ?? '');
    if (!name || TOTAL_ROWS[name]) continue;
    const rate = num(cells[cells.length - 1]);
    rows.push({
      name,
      capacityM3: num(cells[cells.length - 3]),
      storageVolumeM3: num(cells[cells.length - 2]),
      storageRate: rate === null ? null : rate / 100,
      suspended: flat(cells[cells.length - 3] ?? '') === '休止中',
    });
  }
  return { observedAt, rows };
}

// --- matching ---------------------------------------------------------------

export interface NagasakiMaster extends BindableMaster {
  ndi: string | null;
}

/** Name without （元）/（再）, ダム, or the ヶ/ケ spelling difference. */
function stemOf(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/\((?:元|再)\)$/, '')
    .replace(/ダム$/, '')
    .replace(/ヶ/g, 'ケ')
    .trim();
}

/** The NDI pin, else the stamped row, else the dam of the same name (twin rule). */
export function chooseMaster(name: string, masters: NagasakiMaster[]): bigint | null {
  const pin = NDI_PINS[name];
  if (pin) return masters.find((m) => m.ndi === pin)?.id ?? null;
  const stamped = stampedMaster(masters, name);
  if (stamped) return stamped.id;
  const stem = stemOf(name);
  let best: NagasakiMaster | null = null;
  for (const m of masters) {
    if (stemOf(m.name) !== stem) continue;
    if (!best || preferMaster(m, best)) best = m;
  }
  return best?.id ?? null;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 293,
            '長崎市上下水道局 長崎市ダム貯水量一覧表 — 浦上 (週次 HTML, 貯水量+貯水率)',
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

  const { observedAt, rows } = parseNagasakiDamList(await r.text());
  log(`${SOURCE_ID}: parsed ${rows.length} dams, 現在 ${observedAt?.toISOString() ?? 'missing'}`);
  if (!observedAt || rows.length === 0) {
    throw new Error(
      `${SOURCE_ID}: ${rows.length} dams / date ${observedAt ? 'found' : 'missing'} on ${PAGE_URL} — layout change?`,
    );
  }

  const masters = await sql<NagasakiMaster[]>`
    SELECT id, name, completed_year AS "completedYear", external_ids->>'ndi' AS ndi,
           external_ids->>${SOURCE_ID} AS stamp
    FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;

  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];
  const inputs = [] as Parameters<typeof upsertObservations>[0];
  const drift: string[] = [];
  for (const p of rows) {
    const damId = chooseMaster(p.name, masters);
    const row: UniverseRow = {
      externalId: p.name,
      name: p.name,
      prefCode: PREF_CODE,
      resolvedDamId: damId,
      // 休止中 is the city saying the dam has no readings; a blank cell on a
      // live dam stays unknown, since that may be our parser.
      hasData: p.suspended ? false : null,
    };
    universe.push(row);
    const want = WRITE[p.name];
    if (!want) continue;
    if (!damId) {
      log(`${SOURCE_ID}: no master match for "${p.name}"`);
      continue;
    }
    if (p.capacityM3 !== want.capacityM3) {
      drift.push(`${p.name} 水道有効量 ${p.capacityM3} (binding assumes ${want.capacityM3})`);
      continue;
    }
    await bindExternalId(damId, SOURCE_ID, p.name);
    if (p.storageVolumeM3 === null && p.storageRate === null) continue;
    // The 「…現在」 date is the newest value the city publishes: holding it
    // keeps 浦上 covered while the weekly table lapses (8月24日 on 2026-10-02).
    row.publishedAt = observedAt;
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
  await recordUniverse(SOURCE_ID, universe);

  const written = await upsertObservations(inputs);
  log(
    `${SOURCE_ID} done: parsed=${rows.length} matched=${universe.filter((u) => u.resolvedDamId).length} written=${written}`,
  );

  if (drift.length > 0) {
    // The pinned binding no longer fits the page (浦上's 再開発 finishing
    // would drop it to ~1,200,000): fix NDI_PINS/WRITE before writing again.
    throw new Error(`${SOURCE_ID}: ${drift.join('; ')} — re-check NDI_PINS`);
  }
};

export default task;
