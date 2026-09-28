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
// own, so a row is read by position; a 合計 is read only to give back a
// malformed 貯水量 (below). No time of day is printed, so a reading is stamped
// 00:00 JST on the 現在 date.
//
// Volume: 貯水量 is the whole reservoir's volume on the utility's own
// capacity table. For all but 天川第２ that is the 有効 volume, the basis the
// 0036 trigger divides by 有効貯水容量. Checked against 兵庫県's telemetry on
// 2026-08-20 (hyogo-bodik, 09:10 JST): 牛内 529,321 vs 530,000; 成相・北富士
// 1,890,150 vs 1,501,000 + 394,000.
//
// Rate: not stored. 貯水率 is taken against the utility's own capacities, which
// volume / rate back-solves to (千m³, 8/20 and 9/23): 猪鼻第１ 311.5 / 311.2
// (master 有効 304), 猪鼻第２ 479.3 (479), 竹原 525 / 525.4 (618), 天川第２
// 111.2 / 111.2 (53; 総 112), 牛内 1,100 / 1,099 (2,100) and 本庄川 710 / 709.7
// (1,610), the last two the 利水 share of a 多目的 dam. The trigger derives
// volume / 有効 instead, which for 猪鼻第２ is the same figure.
//
// 天川第２ is counted from the bed, as ingest_jwa_fukudou's 山口調整池 is: its
// 111.2 千m³ basis is the 総貯水容量 (NDI W01-14 damCode 1556 totalPondage 112;
// ダム便覧 No.1528 総/有効 112 / 53 千m³, checked 2026-09-28 — the only published
// 有効, so master:refresh:damnet would put 53 back over any correction). The
// utility's own history agrees (web.archive.org captures 2013–2026): it sits at
// 111,000–111,700 nearly always, and its one deep drawdown (令和5年3月19日,
// 58,000 at 52.2 %) stopped at the 59 千m³ that 総 − 有効 puts below 最低水位.
// So what is stored is 貯水量 − (master 総 − 有効), floored at 0 (storedVolume).
// Other figures for the dam do not fit the page: 洲本市「広報すもと」's 総
// 122,000 m³ and 兵庫県's 126 千m³ (淡路地域総合治水推進計画 表26, from ダム年鑑
// 2011) sit 10–13 % above the basis every capture since 2013 ties to.
//
// The table is typed by hand. The 9/23 edit printed 猪鼻第２ as 「479,2000」 at
// 100.0 %, so a 貯水量 is read only when its comma grouping is well formed,
// and written only when volume / 貯水率 lands near that dam's back-solved
// basis and the stored volume stays under 1.2× the master 有効 (storedVolume).
// A malformed 貯水量 in a pair sharing a 合計 is read back as 合計 minus the
// partner's own volume (783,200 − 304,000 = 479,200 for that edit), both
// well formed, and then faces the same check against its own 貯水率.
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

/** A page row's pinned master and the basis its 貯水量 is counted on. */
export interface Pin {
  ndi: string;
  /** The utility capacity its 貯水率 is taken against (back-solved above, m³). */
  basisM3: number;
  /** Whether its 貯水量 is written. */
  write: boolean;
  /** 貯水量 counts from the bed: basisM3 is the master 総貯水容量, not 有効. */
  gross?: true;
}

/**
 * Page row (NFKC-folded ダム名称) → Pin. Pinned rather than matched by name:
 * the page says 猪鼻第１ダム for the master 猪ノ鼻, and the list is the
 * utility's fixed set of reservoirs.
 *
 * - 牛内 is bound but not written: kasenbosai and hyogo-bodik carry it hourly
 *   with the same volume.
 * - Not listed, so unresolved in the universe: 天川第１ダム (no master row) and
 *   成相・北富士ダム (one figure for 成相 NDI 1592 and 北富士 NDI 1596).
 */
export const PINNED: Readonly<Record<string, Pin>> = {
  猪鼻第1ダム: { ndi: '1588', basisM3: 311_000, write: true },
  猪鼻第2ダム: { ndi: '1589', basisM3: 479_000, write: true },
  竹原ダム: { ndi: '1586', basisM3: 525_000, write: true },
  天川第2ダム: { ndi: '1556', basisM3: 111_000, write: true, gross: true },
  牛内ダム: { ndi: '1598', basisM3: 1_100_000, write: false },
  本庄川ダム: { ndi: '1591', basisM3: 710_000, write: true },
};

// volume / 貯水率 may stray this far from basisM3 (a one-decimal rate near 1 %
// is off by 5 %), and the stored volume may reach this multiple of the master
// 有効 (猪鼻第１'s basis is 1.02× it, and a reservoir can spill over the top).
const BASIS_TOLERANCE = 0.15;
const MAX_ACTIVE_MULTIPLE = 1.2;
// A gross pin's basis may stray this far from the master 総貯水容量 (天川第２:
// 111 / 112). Any further and 総 − 有効 no longer marks the page's 最低水位:
// 兵庫県's 126 in place of 112 would move it by a quarter of 有効.
const GROSS_TIE = 0.02;

// --- parsing ----------------------------------------------------------------

export interface ParsedRow {
  /** NFKC-folded ダム名称 ("猪鼻第1ダム"); also the stamp and universe key. */
  name: string;
  /** The 貯水量 cell as printed (folded), kept for the log when unreadable. */
  volumeText: string;
  /** 貯水量 (m³); null for a dash or a malformed number such as 「479,2000」 its pair's 合計 cannot give back. */
  storageVolumeM3: number | null;
  /** The volume is the shared 合計 minus the partner's, its own cell being malformed. */
  volumeFromTotal: boolean;
  /** 貯水率 (%) on the utility's own basis; checks the volume, never stored. */
  ratePct: number | null;
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

/** A 貯水量 as printed, when its comma grouping is well formed. */
function volume(text: string): number | null {
  return /^(?:\d{1,3}(?:,\d{3})*|\d+)$/.test(text) ? Number(text.replace(/,/g, '')) : null;
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
    [...(tr[1] ?? '').matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)].map((td) => ({
      text: flat(td[2] ?? ''),
      rowspan2: /rowspan="?2/.test(td[1] ?? ''),
    })),
  );
  const header = (trs[0] ?? []).map((c) => c.text);
  if (
    header[0] !== 'ダム名称' ||
    !header[2]?.startsWith('貯水量') ||
    !header[3]?.startsWith('貯水率')
  ) {
    throw new Error(`${SOURCE_ID}: header [${header.join(' | ')}] — layout change?`);
  }

  const rows: ParsedRow[] = [];
  // The rowspan=2 合計 貯水量 opened by the previous row, for its partner below.
  let pairTotal: { first: ParsedRow; total: number | null } | null = null;
  for (const cells of trs) {
    const name = cells[0]?.text ?? '';
    if (cells.length < 4 || !name.endsWith('ダム')) continue;
    const volumeText = cells[2]?.text ?? '';
    const rate = (cells[3]?.text ?? '').match(/^(\d+(?:\.\d+)?)%?$/)?.[1];
    const row: ParsedRow = {
      name,
      volumeText,
      storageVolumeM3: volume(volumeText),
      volumeFromTotal: false,
      ratePct: rate === undefined ? null : Number(rate),
    };
    rows.push(row);
    const pair = pairTotal;
    pairTotal = cells[4]?.rowspan2 ? { first: row, total: volume(cells[4].text) } : null;
    if (!pair || pair.total === null) continue;
    // Exactly one of the pair malformed (a digit typed, grouping broken), the
    // other and the 合計 well formed: the 合計 gives the malformed one back.
    const [broken, other] = row.storageVolumeM3 === null ? [row, pair.first] : [pair.first, row];
    if (
      broken.storageVolumeM3 === null &&
      /\d/.test(broken.volumeText) &&
      other.storageVolumeM3 !== null &&
      pair.total >= other.storageVolumeM3
    ) {
      rows[rows.indexOf(broken)] = {
        ...broken,
        storageVolumeM3: pair.total - other.storageVolumeM3,
        volumeFromTotal: true,
      };
    }
  }
  if (rows.length === 0) throw new Error(`${SOURCE_ID}: no dam rows — layout change?`);
  return { observedAt, rows };
}

export interface MasterCapacity {
  totalM3: number | null;
  activeM3: number | null;
}

/** The volume to write (m³, on the master's 有効 basis), or why none is. */
export type StoredVolume = { volumeM3: number } | { problem: string };

/**
 * The row's volume on the basis the trigger divides by 有効貯水容量: the
 * printed 貯水量, or for a gross pin 貯水量 less the master 総 − 有効 (the water
 * below 最低水位), floored at 0. Written only when the capacity volume / 貯水率
 * implies is within BASIS_TOLERANCE of the pinned basis and the stored volume
 * is at most MAX_ACTIVE_MULTIPLE × the master 有効. A row without a positive
 * 貯水率 cannot be checked and is not written.
 */
export function storedVolume(
  row: Pick<ParsedRow, 'storageVolumeM3' | 'ratePct'>,
  pin: Pick<Pin, 'basisM3' | 'gross'>,
  master: MasterCapacity,
): StoredVolume {
  const volume = row.storageVolumeM3;
  if (volume === null) return { problem: 'no 貯水量' };
  if (row.ratePct === null || row.ratePct <= 0) {
    return { problem: `no 貯水率 to check ${volume} m³ against` };
  }
  const implied = volume / (row.ratePct / 100);
  if (Math.abs(implied / pin.basisM3 - 1) > BASIS_TOLERANCE) {
    return {
      problem: `${volume} m³ at ${row.ratePct} % implies ${Math.round(implied)} m³, not ~${pin.basisM3}`,
    };
  }
  let stored = volume;
  if (pin.gross) {
    const { totalM3: total, activeM3: active } = master;
    if (total === null || active === null) {
      return { problem: `gross 貯水量 needs the master 総 and 有効 (${total} / ${active})` };
    }
    if (Math.abs(pin.basisM3 / total - 1) > GROSS_TIE) {
      return {
        problem: `basis ${pin.basisM3} m³ no longer ties to the master 総貯水容量 ${total}`,
      };
    }
    stored = Math.max(0, volume - (total - active));
  }
  if (master.activeM3 !== null && stored > master.activeM3 * MAX_ACTIVE_MULTIPLE) {
    return {
      problem: `${stored} m³ exceeds ${MAX_ACTIVE_MULTIPLE}× the master 有効 ${master.activeM3} m³`,
    };
  }
  return { volumeM3: stored };
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
  const masters = await sql<
    { id: bigint; ndi: string; total: string | null; active: string | null }[]
  >`
    SELECT id, external_ids->>'ndi' AS ndi,
           total_capacity_m3 AS total, active_capacity_m3 AS active
    FROM dams WHERE pref_code = ${PREF_CODE} AND external_ids->>'ndi' IN ${sql(ndis)}
  `;
  const masterByNdi = new Map(masters.map((m) => [m.ndi, m]));

  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];
  const inputs = [] as Parameters<typeof upsertObservations>[0];
  let matched = 0;
  for (const row of page.rows) {
    const pin = PINNED[row.name];
    const master = pin ? (masterByNdi.get(pin.ndi) ?? null) : null;
    const damId = master?.id ?? null;
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
    if (!pin.write) continue;
    const stored = storedVolume(row, pin, {
      totalM3: master?.total == null ? null : Number(master.total),
      activeM3: master?.active == null ? null : Number(master.active),
    });
    if ('problem' in stored) {
      log(
        `${SOURCE_ID}: "${row.name}" 貯水量 「${row.volumeText}」 not written: ${stored.problem}`,
      );
      continue;
    }
    if (row.volumeFromTotal) {
      log(
        `${SOURCE_ID}: "${row.name}" 貯水量 「${row.volumeText}」 read from the 合計 as ${row.storageVolumeM3}`,
      );
    }
    inputs.push({
      observedAt: page.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: stored.volumeM3,
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
