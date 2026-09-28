// apps/worker/src/tasks/ingest_sue_suido.ts
//
// 須恵町上下水道課「貯水率」 — 貯水率 of the town's four 水道 sources, monthly.
//
// Source: https://www.town.sue.fukuoka.jp/soshiki/jogesuido/jogesuido/josuido/1394.html
// Two UTF-8 tables: 「現在の貯水率の詳細」 (a row of names — 須恵ダム / 中柱田貯水池 /
// 旧男鳥溜池 / 新男鳥溜池 — over a row of whole-percent rates) and 「過去1年間の
// 月別貯水率の詳細」 (one row per month, no day). Only the 現在 table is read:
// the month rows carry no survey day. The page prints no date of its own for
// the 現在 figures either; it is dated by the CMS 「更新日：2026年09月01日」 at
// 00:00 JST, the day the town published them (the 月別 table's newest row, 8月,
// repeats them, so the page is re-issued about monthly).
//
// Rate only: the page prints neither volumes nor the capacity it divides by,
// so no volume is stored or derived and the rate is left untrusted — the
// site's dam page shows no 貯水率 without a volume (#60), but the dam's
// published series and its /coverage status are real.
//
// 須恵ダム → 須恵 (NDI 2441, 須恵町, 水道): the only 須恵 in pref 40. The other
// three are not in the NDI master (not_dam_reason in migration 0219).
//
// Priority 293: nothing else publishes 須恵. Cron daily 06:17 UTC (15:17 JST).

import { type BindableMaster, stampedMaster } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const PAGE_URL =
  process.env.SUE_SUIDO_URL ??
  'https://www.town.sue.fukuoka.jp/soshiki/jogesuido/jogesuido/josuido/1394.html';

const PREF_CODE = '40';
const SOURCE_ID = 'sue-suido';

// --- parsing ----------------------------------------------------------------

export interface ParsedRow {
  /** Name as printed ("須恵ダム"); also the stamp and universe key. */
  name: string;
  /** 貯水率 as a 0..1 fraction. */
  storageRate: number | null;
}

export interface ParsedPage {
  /** 更新日 at 00:00 JST, or null if it is missing. */
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

export function parseSueRates(html: string): ParsedPage {
  const d = flat(html).match(/更新日:(\d{4})年(\d{1,2})月(\d{1,2})日/);
  const observedAt = d
    ? new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), -9))
    : null;

  const start = html.indexOf('<caption>現在の貯水率の詳細</caption>');
  const body = start >= 0 ? html.slice(start) : '';
  const table = body.slice(0, body.indexOf('</table>'));
  const [names, rates] = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((tr) =>
    [...(tr[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => flat(c[1] ?? '')),
  );

  const rows: ParsedRow[] = (names ?? []).map((name, i) => {
    const m = (rates?.[i] ?? '').match(/^(\d+(?:\.\d+)?)%$/);
    return { name, storageRate: m ? Number(m[1]) / 100 : null };
  });
  return { observedAt, rows: rows.filter((r) => r.name) };
}

// --- matching ---------------------------------------------------------------

export type SueMaster = BindableMaster;

/** The stamped row, else the one master row named like the page's ダム. */
export function chooseMaster(name: string, masters: SueMaster[]): bigint | null {
  const stamped = stampedMaster(masters, name);
  if (stamped) return stamped.id;
  const stem = name.replace(/ダム$/, '');
  const hits = masters.filter((m) => m.name.normalize('NFKC') === stem);
  return hits.length === 1 ? (hits[0]?.id ?? null) : null;
}

export interface SuePlan {
  universe: UniverseRow[];
  writes: { damId: bigint; row: ParsedRow }[];
}

/** The whole list for the universe; the rate for every matched row that has one. */
export function planSue(rows: ParsedRow[], masters: SueMaster[]): SuePlan {
  const universe: UniverseRow[] = [];
  const writes: SuePlan['writes'] = [];
  for (const row of rows) {
    const damId = chooseMaster(row.name, masters);
    universe.push({
      externalId: row.name,
      name: row.name,
      prefCode: PREF_CODE,
      resolvedDamId: damId,
      hasData: row.storageRate === null ? null : true,
    });
    if (damId && row.storageRate !== null) writes.push({ damId, row });
  }
  return { universe, writes };
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 293,
            '須恵町上下水道課 貯水率 — 須恵ダム (月次, 貯水率のみ)',
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

  const { observedAt, rows } = parseSueRates(await r.text());
  log(`${SOURCE_ID}: parsed ${rows.length} rows, 更新日 ${observedAt?.toISOString() ?? 'missing'}`);
  if (!observedAt || rows.length === 0) {
    throw new Error(
      `${SOURCE_ID}: ${rows.length} rows / date ${observedAt ? 'found' : 'missing'} on ${PAGE_URL} — layout change?`,
    );
  }

  const masters = await sql<SueMaster[]>`
    SELECT id, name, completed_year AS "completedYear", external_ids->>${SOURCE_ID} AS stamp
    FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const plan = planSue(rows, masters);
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
      storageVolumeM3: null,
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
