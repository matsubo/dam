// apps/worker/src/tasks/ingest_skr_hiji.ts
//
// 国土交通省 四国地方整備局 肱川ダム統合管理事務所 — 2 国管理ダム hourly (EUC-JP HTML).
//
//   野村ダム  (Ehime/38, 肱川水系)  obs_id 1368080276020
//   鹿野川ダム (Ehime/38, 肱川水系)  obs_id 1368080255010
//
// Source:
//   http://www1.river.go.jp/cgi-bin/DspDamData.exe?ID={obs_id}&KIND=3&PAGE=0
//   Outer page embeds an IFRAME pointing to the actual EUC-JP HTML data table.
//   The IFRAME URL is dynamic per request; must be parsed from the outer page.
//
// Format: 7 columns per <TR> in the IFRAME HTML:
//   [0] date "YYYY/MM/DD"
//   [1] time "HH:MM"
//   [2] rainfall mm
//   [3] storage 千m³  (× 1000 → m³)
//   [4] inflow  m³/s
//   [5] outflow m³/s
//   [6] storage rate % (→ / 100 = ratio)
//
// The newest row carrying a storage or flow value is the reading; a table
// whose every dated row is marked (欠測, 閉局…) in those columns is
// provider-marked empty. A page pair per dam: one that fails to load leaves
// that dam unreadable.
//
// Priority 303 (MLIT-managed dam). Cron hourly at :23.

import { type Cell, cellState, MARKED, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const BASE_URL =
  process.env.WWW1_RIVER_DAM_BASE ?? 'http://www1.river.go.jp/cgi-bin/DspDamData.exe';

const SOURCE_ID = 'skr-hiji-dam';

// --- dam configuration -------------------------------------------------------

interface DamCfg {
  obsId: string;
  name: string;
  prefCode: string;
}

const DAM_CONFIG: DamCfg[] = [
  { obsId: '1368080276020', name: '野村ダム', prefCode: '38' },
  { obsId: '1368080255010', name: '鹿野川ダム', prefCode: '38' },
];

// --- parsing -----------------------------------------------------------------

function stripTags(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 欠測 / 閉局 / 未受信 / a dash run are the table's own "no value" marks. */
function parseCell(s: string): Cell {
  const t = s.trim();
  if (/^(?:欠測|閉局|未受信|調整中|[-－―ー−*＊]+)$/.test(t)) return MARKED;
  const m = t.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** "YYYY/MM/DD HH:MM" JST → UTC. */
export function parseHijiTimestamp(date: string, time: string): Date | null {
  const dm = date.trim().match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  const tm = time.trim().match(/^(\d{2}):(\d{2})$/);
  if (!dm || !tm) return null;
  const d = new Date(
    Date.UTC(
      Number(dm[1]),
      Number(dm[2]) - 1,
      Number(dm[3]),
      Number(tm[1]) - 9,
      Number(tm[2]),
      0,
      0,
    ),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The first (most recent) row carrying a stored value; rows run newest first. */
export function hijiReading(html: string): Reading {
  let marked = false;
  for (const tr of html.matchAll(/<TR[^>]*>([\s\S]*?)<\/TR>/gi)) {
    const tds = Array.from((tr[1] ?? '').matchAll(/<TD[^>]*>([\s\S]*?)<\/TD>/gi)).map((m) =>
      stripTags(m[1] ?? ''),
    );
    if (tds.length < 7) continue;

    const observedAt = parseHijiTimestamp(tds[0] ?? '', tds[1] ?? '');
    if (!observedAt) continue;

    const rain = parseCell(tds[2] ?? '');
    const storageThou = parseCell(tds[3] ?? '');
    const inflow = parseCell(tds[4] ?? '');
    const outflow = parseCell(tds[5] ?? '');
    const ratePct = numberIn(parseCell(tds[6] ?? ''));

    const state = cellState([storageThou, inflow, outflow]);
    if (state === 'empty') marked = true;
    if (state !== 'values') continue;

    const thou = numberIn(storageThou);
    return {
      state: 'values',
      observations: [
        {
          observedAt,
          rainfallMm: numberIn(rain),
          storageVolumeM3: thou !== null ? thou * 1000 : null,
          inflowM3s: numberIn(inflow),
          outflowM3s: numberIn(outflow),
          storageRate: ratePct !== null ? Math.max(0, Math.min(1, ratePct / 100)) : null,
        },
      ],
    };
  }
  return marked
    ? { state: 'empty', mark: '欠測 in every stored column of every row' }
    : { state: 'unreadable', why: 'no row with a stored value' };
}

/** The IFRAME the outer page embeds; its URL is dynamic per request. */
export function hijiIframeUrl(outerHtml: string): string | null {
  const m = outerHtml.match(/<IFRAME[^>]+src="(\/html\/frm\/DamFree10Data[^"]+)"/i);
  return m ? `http://www1.river.go.jp${m[1]}` : null;
}

/** Both dams, each read from its own outer page and IFRAME once the run reaches it. */
export function hijiEntries(fetchPage: (url: string) => Promise<string>): Entry[] {
  return DAM_CONFIG.map((cfg) => ({
    key: cfg.obsId,
    name: cfg.name,
    pref: cfg.prefCode,
    reading: async () => {
      const iframeUrl = hijiIframeUrl(await fetchPage(`${BASE_URL}?ID=${cfg.obsId}&KIND=3&PAGE=0`));
      if (!iframeUrl) return { state: 'unreadable', why: 'no IFRAME src on the outer page' };
      return hijiReading(await fetchPage(iframeUrl));
    },
  }));
}

// --- HTTP helpers ------------------------------------------------------------

async function fetchEucJp(url: string): Promise<string> {
  const r = await fetch(url, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) throw new Error(`HTTP ${r.status} for ${url}`);
  return new TextDecoder('euc-jp').decode(await r.arrayBuffer());
}

export default ingestTask(SOURCE_ID, async () => ({ entries: hijiEntries(fetchEucJp) }));
