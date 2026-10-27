// apps/worker/src/tasks/ingest_syowaike.ts
//
// 兵庫県 昭和池防災情報管理システム — 昭和池 (加東市馬瀬, 加古川水系, 兵庫/28),
// a 兵庫県-managed irrigation reservoir (NDI 1539, 有効貯水容量 1,500 千m³)
// that no other live source publishes.
//
// Source: the system's public テレメータデータ page (Windows-31J HTML), a
// single snapshot the site says is 「10分毎に更新」:
//   http://www.syowaike.jp/public/DamData.jsp
//
//   更新時刻：YYYY/MM/DD HH:MM:SS (JST); 0000/00/00 would mean offline.
//   One <tr> per item, label cell bgcolor #aaffaa, value cell #ccccff when
//   正常 and #ff8080 when 無効/欠測 (the page's own legend):
//     貯水位(m)      → water level (EL)
//     貯水量(m³)     → storage volume, already m³
//     貯水率(%)      — integer only; not stored. 183,800 / 1,500,000 = 12.3 %
//                      against a printed 12, so the 0051 trigger derives the
//                      same figure from the volume at full precision.
//     流入量(m³/s)   → inflow
//     越流量(m³/s)   — not stored as outflow. Term.html defines it as what
//                      spills over the 洪水吐; the release through the intake
//                      (放流量) is a separate figure this page does not
//                      publish, so 越流量 would read 0 while irrigation draws
//                      the pool down.
//     流入水位(m)    — gauge stage on the inflow channel; not stored.
//     時間雨量(mm)   → rainfall (「毎時00分の過去1時間」)
//
// Licence: the top page's 利用における注意事項 carries only an accuracy
// caveat and 「兵庫県は何ら責任を負うものではありません」; no reuse or tool
// restriction. robots.txt is 404.
//
// Priority 299. Cron hourly at :23 (the page updated at :01/:21/:41 while
// this was written).

import { type Cell, cell, cellState, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const PAGE_URL = process.env.SYOWAIKE_URL ?? 'http://www.syowaike.jp/public/DamData.jsp';

const SOURCE_ID = 'syowaike';
const PREF_CODE = '28';
/** The page publishes one reservoir and no station code; its name is the key. */
const STATION = '昭和池';
// Nine masters are named 昭和池, two of them in 兵庫: NDI 1539 is 兵庫県's
// 1,502 千m³ reservoir at 加東市馬瀬 (this system's 「兵庫加東地区昭和池」),
// NDI 1583 淡路町's 62 千m³ pond in 淡路市. Name matching cannot tell them
// apart, so the binding is pinned.
const NDI = '1539';

/** The テレメータデータ page's reading. */
export function syowaikeReading(html: string): Reading {
  const ts = html.match(/更新時刻[：:]\s*(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
  if (!ts) return { state: 'unreadable', why: 'no 更新時刻' };
  if (Number(ts[1]) === 0) return { state: 'empty', mark: '更新時刻 0000/00/00 (offline)' };
  const observedAt = new Date(
    Date.UTC(Number(ts[1]), Number(ts[2]) - 1, Number(ts[3]), Number(ts[4]) - 9, Number(ts[5])),
  );

  const values = new Map<string, Cell>();
  for (const m of html.matchAll(
    /<td[^>]*bgcolor="#aaffaa"[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*bgcolor="(#[0-9a-f]{6})"[^>]*>([\s\S]*?)<\/td>/gi,
  )) {
    const label = (m[1] ?? '').replace(/<[^>]+>/g, '').trim();
    const text = (m[3] ?? '').replace(/<[^>]+>|&nbsp;|[\s　,]/g, '');
    // #ff8080 is the page's own 無効/欠測.
    const marked = (m[2] ?? '').toLowerCase() === '#ff8080';
    values.set(label, cell(/^-?\d+(?:\.\d+)?$/.test(text) ? Number(text) : null, marked));
  }

  const level = values.get('貯水位(m)') ?? null;
  const volume = values.get('貯水量(m3)') ?? null;
  const inflow = values.get('流入量(m3/s)') ?? null;
  const rain = values.get('時間雨量(mm)') ?? null;
  const state = cellState([level, volume, inflow, rain]);
  if (state === 'empty') return { state, mark: '無効/欠測 on every stored item' };
  if (state === 'unreadable') return { state, why: 'no readable value' };
  return {
    state,
    observations: [
      {
        observedAt,
        waterLevelM: numberIn(level),
        storageVolumeM3: numberIn(volume),
        inflowM3s: numberIn(inflow),
        rainfallMm: numberIn(rain),
      },
    ],
  };
}

function entry(reading: Reading): Entry {
  return { key: STATION, name: STATION, pref: PREF_CODE, bind: { ndi: NDI }, reading };
}

export function syowaikeEntries(html: string): Entry[] {
  return [entry(syowaikeReading(html))];
}

export default ingestTask(SOURCE_ID, async ({ log, upstream }) => {
  try {
    const res = await upstream.fetch(PAGE_URL, { timeoutMs: 15_000 });
    return { entries: syowaikeEntries(res.text('shift_jis')) };
  } catch (err) {
    // The system publishes the reservoir whether or not this run's page loads.
    const why = err instanceof Error ? err.message : String(err);
    log(`${SOURCE_ID}: ${why}`);
    return { entries: [entry({ state: 'unreadable', why })] };
  }
});
