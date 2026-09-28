// apps/worker/src/tasks/ingest_hirado_suido.ts
//
// 平戸市水道局「市内水道用ダムの貯水状況について」 — the city's 8 水道 sources,
// about every ten days.
//
// Source: https://www.city.hirado.nagasaki.jp/kurashi/life/water/cyosuiritsu.html
// One UTF-8 table captioned 市内水道用ダム貯水率:
//   ダム名称 | 満水量 (㎥) | 貯水量 (㎥) | 貯水率 (％)
// with a 「８か所計」 total row, dated by a note under it, 「（注）令和８年９月24日現在」
// (full-width digits, no time: stamped 00:00 JST). The linked detail PDF
// (files/damutyosui.0924.pdf) prints this edition beside the previous one,
// R8.9.14, so the table is re-issued roughly every ten days.
//
// Rows: 神曽根 / 箕坪 / 阿奈田 / 神の川 / 桜川 are master dams no other source
// publishes (all 平戸市 水道; 神の川 and 桜川 came from 生月町 in the 2005
// merger). 平床の池 (3,000 m³) and the 轟川 / 東流川 砂防ダム are not in the NDI
// master; they are recorded unresolved and migration 0219 gives them a
// not_dam_reason.
//
// 神曽根ダム → 神曽根第2 (NDI 2639) by pin: the master has no other 神曽根, but
// the page drops the 「第2」, so a name rule would need a prefix match. The
// pin's evidence: the 「神曽根ダム」 point on mapion (L0680168, 33.35285 N
// 129.51438 E) lies 57 m from the master's 神曽根第2 (33.35234 N 129.51434 E),
// ダム便覧 3683 has 神曽根第2 (平戸市下中野町) as the only 神曽根 dam, and the
// page's 満水量 100,000 fits inside its 有効 120,000.
//
// Rate: 貯水量 / 満水量 as printed (89,000 / 100,000 = 89.0 %). The 満水量 is the
// city's 水道 pool and differs from the master's 有効 for three dams (阿奈田
// 130,000 vs 160,000; 神の川 160,000 vs 223,000; 神曽根 100,000 vs 120,000);
// trusted in 0219, as sasebo-suido's 川谷 share was in 0098.
//
// Priority 293: nothing else publishes these dams. Cron daily 06:44 UTC
// (15:44 JST); a re-run of an unchanged edition re-upserts the same rows.

import { type BindableMaster, stampedMaster } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const PAGE_URL =
  process.env.HIRADO_SUIDO_URL ??
  'https://www.city.hirado.nagasaki.jp/kurashi/life/water/cyosuiritsu.html';

const PREF_CODE = '42';
const SOURCE_ID = 'hirado-suido';

/** Page names whose master row the name rule cannot reach, pinned by NDI (see header). */
const NDI_PINS: Readonly<Record<string, string>> = {
  神曽根ダム: '2639',
};

// --- parsing ----------------------------------------------------------------

export interface ParsedRow {
  /** ダム名称 as printed ("神の川ダム"); also the stamp and universe key. */
  name: string;
  /** 満水量 (m³), the figure the rate divides by. */
  capacityM3: number | null;
  storageVolumeM3: number | null;
  /** 貯水率 as a 0..1 fraction. */
  storageRate: number | null;
}

export interface ParsedPage {
  /** The 「…現在」 date at 00:00 JST, or null if the note is missing. */
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

/** "383,760㎥" / "73.8％" → number; anything else ("－", blank) → null. */
function num(cell: string | undefined): number | null {
  const m = flat(cell ?? '')
    .replace(/,/g, '')
    .match(/^(\d+(?:\.\d+)?)(?:m3|%)?$/);
  return m ? Number(m[1]) : null;
}

export function parseHiradoDams(html: string): ParsedPage {
  const start = html.indexOf('市内水道用ダム貯水率</caption>');
  const body = start >= 0 ? html.slice(start) : '';
  const table = body.slice(0, body.indexOf('</table>'));

  const rows: ParsedRow[] = [];
  for (const tr of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...(tr[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
    if (cells.length !== 4) continue;
    const name = flat(cells[0] ?? '');
    if (!name || name === 'ダム名称' || /計$/.test(name)) continue;
    const rate = num(cells[3]);
    rows.push({
      name,
      capacityM3: num(cells[1]),
      storageVolumeM3: num(cells[2]),
      storageRate: rate === null ? null : rate / 100,
    });
  }

  // The note follows the table: 「（注）令和８年９月24日現在」.
  const d = flat(body.slice(body.indexOf('</table>'), body.indexOf('</table>') + 400)).match(
    /令和(元|\d+)年(\d{1,2})月(\d{1,2})日現在/,
  );
  const observedAt = d
    ? new Date(
        Date.UTC(2018 + (d[1] === '元' ? 1 : Number(d[1])), Number(d[2]) - 1, Number(d[3]), -9),
      )
    : null;
  return { observedAt, rows };
}

// --- matching ---------------------------------------------------------------

export interface HiradoMaster extends BindableMaster {
  ndi: string | null;
}

/** The NDI pin, else the stamped row, else the one master row named like the page's ダム. */
export function chooseMaster(name: string, masters: HiradoMaster[]): bigint | null {
  const pin = NDI_PINS[name];
  if (pin) return masters.find((m) => m.ndi === pin)?.id ?? null;
  const stamped = stampedMaster(masters, name);
  if (stamped) return stamped.id;
  const stem = name.replace(/ダム$/, '');
  const hits = masters.filter((m) => m.name.normalize('NFKC') === stem);
  return hits.length === 1 ? (hits[0]?.id ?? null) : null;
}

export interface HiradoPlan {
  universe: UniverseRow[];
  writes: { damId: bigint; row: ParsedRow }[];
}

/** The whole list for the universe; readings for every matched row that has one. */
export function planHirado(rows: ParsedRow[], masters: HiradoMaster[]): HiradoPlan {
  const universe: UniverseRow[] = [];
  const writes: HiradoPlan['writes'] = [];
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
            '平戸市水道局 市内水道用ダムの貯水状況 — 5 ダム (約10日毎, 貯水量+貯水率)',
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

  const { observedAt, rows } = parseHiradoDams(await r.text());
  log(`${SOURCE_ID}: parsed ${rows.length} rows, 現在 ${observedAt?.toISOString() ?? 'missing'}`);
  if (!observedAt || rows.length === 0) {
    throw new Error(
      `${SOURCE_ID}: ${rows.length} rows / date ${observedAt ? 'found' : 'missing'} on ${PAGE_URL} — layout change?`,
    );
  }

  const masters = await sql<HiradoMaster[]>`
    SELECT id, name, completed_year AS "completedYear", external_ids->>'ndi' AS ndi,
           external_ids->>${SOURCE_ID} AS stamp
    FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const plan = planHirado(rows, masters);
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
