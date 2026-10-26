// apps/worker/src/tasks/ingest_jwa_fukudou.ts
//
// 水資源機構 筑後川局 福岡導水管理室 — 山口調整池 (天拝湖, 那珂川市), the
// regulating pond of the 福岡導水 that holds 筑後川 water for 福岡都市圏.
//
// Source: https://www.water.go.jp/chikugo/fukudou/html/info02.html
//   One Word-exported Shift_JIS page, regenerated on weekdays at ~04:30 JST
//   with the 0時 reading of that day:
//     令和８年（2026） ９月 ２５日 0時 現在 … 山口調整池
//     貯水位 EL 117.04 m / 総貯水量 3,758,400 m3 / 貯水率 94.0 ％
//   (full-width digits, &nbsp; padding and HTML comments in between). The
//   page also prints the 福岡導水揚水機場 intake of the previous day, which is
//   not a reservoir figure and is not stored.
//
// 総貯水量 is counted from the bed: 3,758,400 / 94.0 % = 3,998,298 m³, the
// 4,000,000 m³ 総貯水容量 of the master, not its 3,900,000 m³ 有効. The
// observation trigger divides the stored volume by 有効貯水容量, so, as in
// ingest_nara_kasen, we store 総貯水量 − 堆砂容量 (総 − 有効 = 100,000 m³) —
// and only while the printed rate still ties to the master 総貯水容量. The
// rate itself is left null: its denominator is the gross capacity, and the
// derived 有効 rate differs from it by at most 2.5 points (at empty).
//
// Only source for 山口調整池, so the priority matters only against future
// ones; 297 matches its sibling jwa-chikugo. Cron hourly at :54 — the page
// changes once a day, and an idempotent upsert on the report hour picks it up.
//
// License: 水資源機構 利用ルール (water.go.jp/honsya/honsya/policy/copyright/)
// — 出典を記載すれば複製・公衆送信・加工・商用利用可; 数値データは著作権の対象外.

import { ingestTask, type Log } from '../ingest/run.ts';
import type { Entry } from '../ingest/types.ts';

const PAGE_URL =
  process.env.JWA_FUKUDOU_URL ?? 'https://www.water.go.jp/chikugo/fukudou/html/info02.html';

const SOURCE_ID = 'jwa-fukudou';
const PREF_CODE = '40';
/** The page's only reservoir; also the stamp and universe key (no code is published). */
const STATION = '山口調整池';

// --- parsing ----------------------------------------------------------------

export interface ParsedReading {
  observedAt: Date;
  waterLevelM: number;
  /** 総貯水量 (m³), counted from the reservoir bed. */
  grossVolumeM3: number;
  /** 貯水率 (%) against 総貯水容量. */
  ratePct: number;
}

export function parseFukudouPage(html: string): ParsedReading | null {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .normalize('NFKC')
    .replace(/\s+/g, ' ');
  const when = text.match(/\(\s*(\d{4})\s*\)\s*(\d{1,2})月\s*(\d{1,2})日\s*(\d{1,2})\s*時\s*現在/);
  // The <title> names the pond too; the readings follow its last mention.
  const at = text.lastIndexOf(STATION);
  if (!when || at < 0) return null;
  const block = text.slice(at);
  const level = block.match(/貯水位\s*EL\s*([\d.]+)\s*m/);
  const volume = block.match(/総貯水量\s*([\d,]+)\s*m3/);
  const rate = block.match(/貯水率\s*([\d.]+)\s*%/);
  if (!level?.[1] || !volume?.[1] || !rate?.[1]) return null;
  return {
    // JST → UTC
    observedAt: new Date(
      Date.UTC(Number(when[1]), Number(when[2]) - 1, Number(when[3]), Number(when[4]) - 9),
    ),
    waterLevelM: Number(level[1]),
    grossVolumeM3: Number(volume[1].replace(/,/g, '')),
    ratePct: Number(rate[1]),
  };
}

export interface MasterCapacity {
  totalCapacityM3: number | null;
  activeCapacityM3: number | null;
}

// Half a whole percent. The page prints 貯水率 with one decimal but rounds it
// to a whole percent: 3,758,400 m³ (93.96 %) and 3,753,400 m³ (93.835 %) of
// 4,000,000 both read "94.0", and no one denominator gives both at one-decimal
// precision. The check still rejects a 有効 denominator (96.4 % at 94.0).
const RATE_ROUNDING = 0.005;

/**
 * Water above 最低水位 (m³), comparable with 有効貯水容量: 総貯水量 less
 * 堆砂容量 (総 − 有効). Null unless the printed rate is 総貯水量 over the
 * master 総貯水容量, which is what ties the gross figure to that capacity table.
 */
export function usableVolumeM3(
  r: Pick<ParsedReading, 'grossVolumeM3' | 'ratePct'>,
  cap: MasterCapacity,
): number | null {
  const { totalCapacityM3: total, activeCapacityM3: active } = cap;
  if (total === null || active === null || total <= 0) return null;
  if (Math.abs(r.ratePct / 100 - r.grossVolumeM3 / total) > RATE_ROUNDING + 1e-9) return null;
  return Math.max(0, r.grossVolumeM3 - (total - active));
}

/**
 * The page's only reservoir. No prefix/substring fallback: 福岡県 also has an
 * unrelated 山口 dam.
 */
const POND = { key: STATION, name: STATION, pref: PREF_CODE, bind: { exact: true } } as const;

/** The pond read from its page: level always, 有効 storage only while it ties to the master. */
export function fukudouEntry(html: string, log: Log = () => {}): Entry {
  const page = parseFukudouPage(html);
  return {
    ...POND,
    reading: (dam) => {
      if (!page) return { state: 'unreadable', why: `no ${STATION} reading on the page` };
      const volume = dam ? usableVolumeM3(page, dam) : null;
      if (dam && volume === null) {
        log(
          `${SOURCE_ID}: volume not stored: 総貯水量 ${page.grossVolumeM3} m³ at ${page.ratePct} % ` +
            `does not tie to master total=${dam.totalCapacityM3 ?? 'null'} active=${dam.activeCapacityM3 ?? 'null'}`,
        );
      }
      return {
        state: 'values',
        observations: [
          { observedAt: page.observedAt, waterLevelM: page.waterLevelM, storageVolumeM3: volume },
        ],
      };
    },
  };
}

async function fetchPage(): Promise<string> {
  const r = await fetch(PAGE_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) throw new Error(`HTTP ${r.status} for ${PAGE_URL}`);
  return new TextDecoder('shift_jis').decode(await r.arrayBuffer());
}

export default ingestTask(SOURCE_ID, async (log) => {
  let html: string;
  try {
    html = await fetchPage();
  } catch (err) {
    // The pond is known in advance: a dead page leaves it unreadable, and the
    // run fails the job so it is retried.
    const why = err instanceof Error ? err.message : String(err);
    return { entries: [{ ...POND, reading: { state: 'unreadable', why } }] };
  }
  return { entries: [fukudouEntry(html, log)] };
});
