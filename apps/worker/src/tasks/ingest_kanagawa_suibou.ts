// apps/worker/src/tasks/ingest_kanagawa_suibou.ts
//
// 神奈川県雨量水位情報 — 飯泉取水堰 (酒匂川, 神奈川県内広域水道企業団, NDI 727)
// pool level, 15-minute values.
//
// The weir is a master dam row (可動堰, no capacity) that no other source
// carries: kanagawa-dam.jp lists only 相模/城山/三保/宮ヶ瀬/道志, and the 企業団
// links to that site for 水源情報. 神奈川県's river-level system has a
// 「15分間隔の観測局」 at the weir:
//
//   https://www.pref.kanagawa.jp/sys/suibou/web_general/suibou_joho/html/stage/15/p10202_18_3585_4_1601.html
//
// UTF-8 水位グラフ(15分) page: header 「観測時刻 YYYY/MM/DD HH:MM」, 観測所名
// 「飯泉取水堰 [Iizumi Intake Weir]」, then a 水位表 of the last 6 h — 24 rows of
// 「HH:MM | level」, the first row and any row that starts a date printed
// 「MM/DD HH:MM」. ** marks 欠測 and -- 未収集.
//
// The level is stored as published. The page prints no datum and no flood
// thresholds (all --); 8.35–8.44 m on 2026-09-28 against a 5.4 m weir 2.3 km
// from the mouth reads as T.P., not a gauge height (the system's river gauges
// read 0.0–0.5 m that day), but nothing on the page says so.
//
// Universe: the system's ~167 stations are river gauges apart from two
// 取水堰 pools, 飯泉取水堰 and 串川取水堰 (串川, 相模原市緑区根小屋). 串川取水堰 is not
// in the NDI master; migration 0209 records why it is not a dam, and its page
// is never fetched.
//
// Priority 308 (prefectural 防災 tier); nothing else covers 飯泉取水堰. Cron
// hourly at :43; the 24 rows re-upserted each run cover 5 missed hours.

import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';
import type { Upstream } from '../ingest/upstream.ts';

const BASE_URL =
  process.env.KANAGAWA_SUIBOU_BASE_URL ??
  'https://www.pref.kanagawa.jp/sys/suibou/web_general/suibou_joho/html/stage/15';

const SOURCE_ID = 'kanagawa-suibou';
const PREF_CODE = '14';

/** The one 取水堰 station that is a master dam; key = the system's station code. */
const IIZUMI = { key: '3585_4_1601', name: '飯泉取水堰', page: 'p10202_18_3585_4_1601.html' };
/** The other 取水堰 station the system publishes: no master dam (0209). */
const KUSHIKAWA = { key: '3585_4_1507', name: '串川取水堰' };

/** 飯泉's 水位グラフ page. */
export const IIZUMI_URL = `${BASE_URL}/${IIZUMI.page}`;

export interface SuibouStage {
  station: string;
  /** Oldest first. */
  readings: { observedAt: Date; waterLevelM: number }[];
  /** Rows the page marks ** (欠測) or -- (未収集). */
  marked: number;
}

/** Parse a 水位グラフ page; null when it carries no 観測時刻. */
export function parseSuibouStage(html: string): SuibouStage | null {
  const head = html.match(/観測時刻[\s\S]{0,80}?(\d{4})\/(\d{2})\/\d{2} \d{2}:\d{2}/);
  const station = html.match(/<th>観測所名<\/th>\s*<td[^>]*>\s*<span>([^<[]+?)\s*[[<]/);
  if (!head) return null;
  const headYear = Number(head[1]);
  const headMonth = Number(head[2]);

  const readings: SuibouStage['readings'] = [];
  let marked = 0;
  let month = 0;
  let day = 0;
  for (const m of html.matchAll(
    /<td class="notranslate">(?:(\d{2})\/(\d{2}) )?(\d{2}):(\d{2})<\/td>\s*<td><span class="notranslate" data-graph-dtkey="stage_item_data_\d+">([^<]*)<\/span>/g,
  )) {
    if (m[1] && m[2]) {
      month = Number(m[1]);
      day = Number(m[2]);
    }
    if (month === 0) continue;
    const level = (m[5] ?? '').trim();
    if (level === '**' || level === '--') marked += 1;
    if (!/^-?\d+(?:\.\d+)?$/.test(level)) continue;
    // A December row on a January page is last year's.
    const year = month > headMonth ? headYear - 1 : headYear;
    readings.push({
      observedAt: new Date(Date.UTC(year, month - 1, day, Number(m[3]) - 9, Number(m[4]))),
      waterLevelM: Number(level),
    });
  }
  return { station: station?.[1] ?? '', readings, marked };
}

/** 飯泉取水堰's reading from its 水位グラフ page. */
export function iizumiReading(html: string): Reading {
  const stage = parseSuibouStage(html);
  if (!stage || stage.station !== IIZUMI.name) {
    return {
      state: 'unreadable',
      why: `${IIZUMI.page} is not the ${IIZUMI.name} graph (station "${stage?.station ?? ''}")`,
    };
  }
  if (stage.readings.length > 0) {
    return {
      state: 'values',
      observations: stage.readings.map((r) => ({
        observedAt: r.observedAt,
        waterLevelM: r.waterLevelM,
      })),
    };
  }
  if (stage.marked > 0) return { state: 'empty', mark: '** 欠測 / -- 未収集 on every row' };
  return { state: 'unreadable', why: 'no 水位表 row' };
}

/** Both 取水堰 stations; only 飯泉's page is read. */
export function suibouEntries(upstream: Upstream): Entry[] {
  return [
    {
      key: IIZUMI.key,
      name: IIZUMI.name,
      pref: PREF_CODE,
      // The master row carries the published name; nothing looser may bind.
      bind: { exact: true },
      reading: async () =>
        iizumiReading((await upstream.fetch(IIZUMI_URL, { timeoutMs: 15_000 })).text()),
    },
    {
      key: KUSHIKAWA.key,
      name: KUSHIKAWA.name,
      pref: PREF_CODE,
      bind: 'never',
      reading: { state: 'unreadable', why: 'not a dam (0209); page not read' },
    },
  ];
}

export default ingestTask(SOURCE_ID, async ({ upstream }) => ({
  entries: suibouEntries(upstream),
}));
