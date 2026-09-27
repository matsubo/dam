// apps/worker/src/tasks/ingest_awaji_suido.ts
//
// 淡路広域水道企業団「各水源地の貯水状況」 — the utility's own reservoirs on 淡路島.
//
// Source: http://www.awaji-suido.jp/osirase-01.html. Static UTF-8 HTML edited
// by hand about once a month (the index lists updates from 2024-02 to
// 2026-08-25). One table, dated 「令和8年8月20日現在の…」 above it:
//   ダム名称 | 水系 | 貯水量（ｍ3） | 貯水率（％） | 合計 貯水量 | 合計 貯水率
// 猪鼻第１/第２ and 天川第１/第２ share rowspan=2 合計 cells after the first
// row's own four; every other 合計 is 「-」. Each row's first four cells are its
// own, so a row is read by position and the 合計 cells are ignored. No time of
// day is printed, so a reading is stamped 00:00 JST on the 現在 date.
//
// Volume: 貯水量 is the whole reservoir's 有効 volume, the basis the 0036
// trigger divides by 有効貯水容量. Checked against 兵庫県's telemetry on
// 2026-08-20 (hyogo-bodik, 09:10 JST): 牛内 529,321 vs 530,000; 成相・北富士
// 1,890,150 vs 1,501,000 + 394,000.
//
// Rate: not stored. 貯水率 is taken against the utility's own capacities, which
// volume / rate back-solves to (千m³, 8/20): 猪鼻第１ 311.5 (master 有効 304),
// 猪鼻第２ 479.3 (479), 竹原 525 (618), 天川第２ 111.2 (53; 総 112), 牛内 1,100
// (2,100) and 本庄川 710 (1,610), the last two the 利水 share of a 多目的 dam.
// The trigger derives volume / 有効 instead, which for 猪鼻第２ is the same figure.
//
// Priority 288. Cron daily; the page changes about monthly and a re-read
// upserts the same rows.

import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const PAGE_URL = process.env.AWAJI_SUIDO_URL ?? 'http://www.awaji-suido.jp/osirase-01.html';

const PREF_CODE = '28';
const SOURCE_ID = 'awaji-suido';

/**
 * Page row (NFKC-folded ダム名称) → master NDI id, and whether its 貯水量 is
 * written. Pinned rather than matched by name: the page says 猪鼻第１ダム for
 * the master 猪ノ鼻, and the list is the utility's fixed set of reservoirs.
 *
 * - 天川第２ is bound but not written: its 81,100 m³ at 72.9 % exceeds the
 *   master 有効 53,000 (総 112,000), so it is not on the master's basis and the
 *   trigger would read 153 %. Either the master 有効 is short or the page
 *   counts the dead storage; until that is settled nothing is stored.
 * - 牛内 is bound but not written: kasenbosai and hyogo-bodik carry it hourly
 *   with the same volume.
 * - Not listed, so unresolved in the universe: 天川第１ダム (no master row) and
 *   成相・北富士ダム (one figure for 成相 NDI 1592 and 北富士 NDI 1596).
 */
const PINNED: Readonly<Record<string, { ndi: string; write: boolean }>> = {
  猪鼻第1ダム: { ndi: '1588', write: true },
  猪鼻第2ダム: { ndi: '1589', write: true },
  竹原ダム: { ndi: '1586', write: true },
  天川第2ダム: { ndi: '1556', write: false },
  牛内ダム: { ndi: '1598', write: false },
  本庄川ダム: { ndi: '1591', write: true },
};

// --- parsing ----------------------------------------------------------------

export interface ParsedRow {
  /** NFKC-folded ダム名称 ("猪鼻第1ダム"); also the stamp and universe key. */
  name: string;
  storageVolumeM3: number | null;
}

export interface ParsedPage {
  observedAt: Date;
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

export function parseAwajiChosui(html: string): ParsedPage {
  const date = flat(html).match(/令和(元|\d+)年(\d{1,2})月(\d{1,2})日現在/);
  if (!date) throw new Error(`${SOURCE_ID}: no 令和…現在 date on the page`);
  const year = 2018 + (date[1] === '元' ? 1 : Number(date[1]));
  const observedAt = new Date(Date.UTC(year, Number(date[2]) - 1, Number(date[3]), -9));

  // The innermost table holding the header; the page nests layout tables.
  const table = [...html.matchAll(/<table[^>]*>((?:(?!<table)[\s\S])*?)<\/table>/g)]
    .map((m) => m[1] ?? '')
    .find((t) => t.includes('ダム名称'));
  const trs = [...(table ?? '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((tr) =>
    [...(tr[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((td) => flat(td[1] ?? '')),
  );
  const header = trs[0] ?? [];
  if (
    header[0] !== 'ダム名称' ||
    !header[2]?.startsWith('貯水量') ||
    !header[3]?.startsWith('貯水率')
  ) {
    throw new Error(`${SOURCE_ID}: header [${header.join(' | ')}] — layout change?`);
  }

  const rows: ParsedRow[] = [];
  for (const cells of trs) {
    const name = cells[0] ?? '';
    if (cells.length < 4 || !name.endsWith('ダム')) continue;
    const volume = (cells[2] ?? '').replace(/,/g, '');
    rows.push({ name, storageVolumeM3: /^\d+$/.test(volume) ? Number(volume) : null });
  }
  if (rows.length === 0) throw new Error(`${SOURCE_ID}: no dam rows — layout change?`);
  return { observedAt, rows };
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 288,
            '淡路広域水道企業団 各水源地の貯水状況 — 淡路島の水道ダム (月次程度 HTML)',
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
  if (r.status !== 200) throw new Error(`${SOURCE_ID}: HTTP ${r.status} from ${PAGE_URL}`);

  const page = parseAwajiChosui(await r.text());
  log(`${SOURCE_ID}: ${page.rows.length} rows at ${page.observedAt.toISOString()}`);

  const ndis = Object.values(PINNED).map((p) => p.ndi);
  const masters = await sql<{ id: bigint; ndi: string }[]>`
    SELECT id, external_ids->>'ndi' AS ndi
    FROM dams WHERE pref_code = ${PREF_CODE} AND external_ids->>'ndi' IN ${sql(ndis)}
  `;
  const damByNdi = new Map(masters.map((m) => [m.ndi, m.id]));

  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];
  const inputs = [] as Parameters<typeof upsertObservations>[0];
  let matched = 0;
  for (const row of page.rows) {
    const pin = PINNED[row.name];
    const damId = pin ? (damByNdi.get(pin.ndi) ?? null) : null;
    universe.push({
      externalId: row.name,
      name: row.name,
      prefCode: PREF_CODE,
      resolvedDamId: damId,
    });
    if (!pin || !damId) {
      log(`${SOURCE_ID}: no master for "${row.name}"`);
      continue;
    }
    matched++;
    await bindExternalId(damId, SOURCE_ID, row.name);
    if (!pin.write || row.storageVolumeM3 === null) continue;
    inputs.push({
      observedAt: page.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: row.storageVolumeM3,
      storageRate: null,
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
  log(`${SOURCE_ID} done: parsed=${page.rows.length} matched=${matched} written=${written}`);
};

export default task;
