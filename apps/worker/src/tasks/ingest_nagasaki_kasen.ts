// apps/worker/src/tasks/ingest_nagasaki_kasen.ts
//
// 長崎県河川砂防情報 ダム情報 — 35 ダム, 30分更新.
//
// Source:
//   https://dam.pref.nagasaki.jp/data/dt_range.json  → max_dt (JST)
//   https://dam.pref.nagasaki.jp/data/dam_m.json     → dam master (dam_cd → name)
//   https://dam.pref.nagasaki.jp/data/all/{ym}/{ymd}/all_{ymd}_{hm}_d.json
// Format: UTF-8 JSON. All times in JST.
// Fields per dam: lv(m), pondage(千m³), in(m³/s), dis(m³/s) and three rates —
// rate_r (利水容量貯水率), rate_y (有効容量貯水率) and rate, which tracks
// rate_y. 長崎県 publishes 利水容量 and 有効貯水容量 separately in dam_m.json
// (tank_risui_d / tank_ecapa), and this site's 貯水率 is the 利水 one.
//
// dam_m.json is 長崎県's own catalogue, so it is what the source publishes —
// not the subset that carried a reading in this run's snapshot: a dam whose
// gauge is silent this run is still published. dam_cd is the upstream's
// stable id, so it is the key. When the snapshot cannot be read, every
// catalogued dam is listed unreadable.
// Priority 308, matching other prefectural sources.

import { ingestTask } from '../ingest/run.ts';
import type { Bind, Entry, Reading } from '../ingest/types.ts';
import type { Upstream } from '../ingest/upstream.ts';

const BASE_URL = process.env.NAGASAKI_KASEN_BASE_URL ?? 'https://dam.pref.nagasaki.jp';

const PREF_CODE = '42';
const SOURCE_ID = 'nagasaki-kasen';

// --- types ------------------------------------------------------------------

interface DtRange {
  min_dt: string;
  max_dt: string;
}

export interface DamMaster {
  dam_cd: number;
  dam_nm: string;
}

export interface DamDataItem {
  dam_cd: number;
  lv: string;
  /** 貯水率 — the feed's headline rate, on the same basis as rate_y. */
  rate: string;
  /** 利水容量貯水率 (%). */
  rate_r?: string;
  /** 有効容量貯水率 (%). */
  rate_y?: string;
  pondage: string;
  in: string;
  dis: string;
}

export interface AllDamsJson {
  ymd: string;
  time: string;
  list: DamDataItem[];
}

// --- parsing ----------------------------------------------------------------

/** "YYYY/MM/DD" + "HH:MM" JST → UTC Date */
export function parseNagasakiDatetime(ymd: string, time: string): Date | null {
  const m1 = ymd.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  const m2 = time.match(/^(\d{2}):(\d{2})$/);
  if (!m1 || !m2) return null;
  const d = new Date(
    Date.UTC(
      Number(m1[1]),
      Number(m1[2]) - 1,
      Number(m1[3]),
      Number(m2[1]) - 9,
      Number(m2[2]),
      0,
      0,
    ),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseNum(s: string): number | null {
  // Volumes ≥ 1,000 千m³ arrive with a thousands separator ("1,938").
  const clean = s.trim().replace(/,/g, '');
  if (!clean) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

/** Build the all-dams snapshot URL from a JST max_dt string "YYYY/MM/DD HH:MM:SS" */
export function buildSnapshotUrl(base: string, maxDt: string): string | null {
  const m = maxDt.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):/);
  if (!m) return null;
  const ym = `${m[1]}${m[2]}`;
  const ymd = `${m[1]}${m[2]}${m[3]}`;
  const hm = `${m[4]}${m[5]}`;
  return `${base}/data/all/${ym}/${ymd}/all_${ymd}_${hm}_d.json`;
}

/**
 * One snapshot item's reading: values when it carries a level or a volume;
 * provider-marked empty when every field is the provider's 「-」 (樋口 /
 * つづら / 笛吹, stat 0); otherwise unreadable — an empty or unparsed field
 * may be our parser rather than the provider.
 */
export function nagasakiReading(item: DamDataItem, observedAt: Date): Reading {
  const pondageRaw = parseNum(item.pondage);
  const waterLevelM = parseNum(item.lv);
  const storageVolumeM3 = pondageRaw !== null ? pondageRaw * 1_000 : null;
  if (waterLevelM === null && storageVolumeM3 === null) {
    const marked = [item.lv, item.pondage, item.rate, item.rate_r, item.rate_y, item.in, item.dis]
      .filter((v) => v !== undefined)
      .every((v) => v.trim() === '-');
    return marked
      ? { state: 'empty', mark: '「-」 in every field' }
      : { state: 'unreadable', why: 'no 貯水位 or 貯水量' };
  }
  // Prefer 利水容量貯水率 (rate_r): it is the rate the manager publishes,
  // against the current-season 利水容量. rate / rate_y divide by the full
  // 有効貯水容量 and understate flood-control dams badly — 宮崎ダム reads
  // 17.5 % on 有効 against 100 % on 利水. Same inversion as issue #19
  // (kasenbosai) and commit ad2323d (cgr_mlit / kumamoto / kochi).
  const ratePct = parseNum(item.rate_r ?? '') ?? parseNum(item.rate_y ?? '') ?? parseNum(item.rate);
  return {
    state: 'values',
    observations: [
      {
        observedAt,
        waterLevelM,
        storageVolumeM3,
        storageRate: ratePct !== null ? ratePct / 100 : null,
        inflowM3s: parseNum(item.in),
        outflowM3s: parseNum(item.dis),
      },
    ],
  };
}

/**
 * Stations the name rule binds wrongly, by dam_cd, pinned to an NDI row.
 *
 * 1106 「小ヶ倉ダム」 → 小ヶ倉 (NDI 2609), 長崎市's dam on the 鹿尾川 — pref 42
 * has a second 小ヶ倉 (NDI 2592, 諫早市), and the lower id picked that one. The
 * 11xx codes are the 長崎市 block (式見, 鹿尾, 本河内…), and on prod every one
 * of the 2,738 readings the station shares an instant with kasenbosai's
 * 「小ヶ倉(補助)ダム」 (bound to 2609) carries the same 貯水位 (87.97–90.89 m;
 * kasenbosai on 2592 reads 0–26 m); mudam's listing 524 is pinned to 2609 too
 * (migration 0073).
 */
const NDI_PINS: Readonly<Record<number, string>> = {
  1106: '2609',
};

/**
 * Every catalogued dam, read from the snapshot; a dam absent from it, or a
 * snapshot that could not be read (`snapshot` a string saying why), is
 * unreadable. The stamp is how a dam whose name differs from the master keeps
 * its binding (け知ダム, stamped dam_cd=2030 by a migration).
 */
export function nagasakiEntries(catalogue: DamMaster[], snapshot: AllDamsJson | string): Entry[] {
  const observedAt =
    typeof snapshot === 'string' ? null : parseNagasakiDatetime(snapshot.ymd, snapshot.time);
  const items = new Map(
    typeof snapshot === 'string' ? [] : snapshot.list.map((i) => [i.dam_cd, i] as const),
  );
  return catalogue.map((m) => {
    const item = items.get(m.dam_cd);
    let reading: Reading;
    if (typeof snapshot === 'string') reading = { state: 'unreadable', why: snapshot };
    else if (!observedAt) {
      reading = { state: 'unreadable', why: `snapshot time "${snapshot.ymd} ${snapshot.time}"` };
    } else if (!item) reading = { state: 'unreadable', why: 'absent from the snapshot' };
    else reading = nagasakiReading(item, observedAt);
    const pin = NDI_PINS[m.dam_cd];
    const bind: Bind | undefined = pin ? { ndi: pin } : undefined;
    return {
      key: String(m.dam_cd),
      name: m.dam_nm,
      pref: PREF_CODE,
      ...(bind ? { bind } : {}),
      reading,
    };
  });
}

// --- task -------------------------------------------------------------------

/** This run's all-dams snapshot, or why it could not be read. */
async function fetchSnapshot(upstream: Upstream): Promise<AllDamsJson | string> {
  try {
    const range = (await upstream.fetch(`${BASE_URL}/data/dt_range.json`)).json<DtRange>();
    const snapshotUrl = buildSnapshotUrl(BASE_URL, range.max_dt);
    if (!snapshotUrl) return `cannot build snapshot URL from max_dt="${range.max_dt}"`;
    return (await upstream.fetch(snapshotUrl)).json<AllDamsJson>();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export default ingestTask(SOURCE_ID, async ({ log, upstream }) => {
  const catalogue = (await upstream.fetch(`${BASE_URL}/data/dam_m.json`)).json<DamMaster[]>();
  const snapshot = await fetchSnapshot(upstream);
  log(
    typeof snapshot === 'string'
      ? `${SOURCE_ID}: snapshot unreadable: ${snapshot}`
      : `${SOURCE_ID}: ${catalogue.length} catalogued, snapshot ${snapshot.ymd} ${snapshot.time}`,
  );
  return { entries: nagasakiEntries(catalogue, snapshot) };
});
