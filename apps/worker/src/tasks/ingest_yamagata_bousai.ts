// apps/worker/src/tasks/ingest_yamagata_bousai.ts
//
// 山形県河川・砂防情報 — 防災Web JSON feed (dk=4), hourly.
//
//   ~17 dams (13 county + 4 MLIT Tohoku): 蔵王/前川/白水川/留山川/高坂/神室/
//   最上小国川/木地山/綱木川/月光川/荒沢/温海川/田沢川 (県管理 mng=1) +
//   長井/寒河江/白川/月山 (国管理 mng=11).
//
// Source: http://www.kasen.pref.yamagata.jp/map/servlet/bousaiweb.servletBousaiMap?dk=4
// Format: Shift_JIS JSON; `date` = "YYYYMMDDHHMMSS" JST; numbered dam keys
//         (1…N, some gaps); data1=貯水位(EL.m), data2=貯水量(千m³),
//         data3=流入量(m³/s), data4=放流量(m³/s), data5=貯水率(%);
//         "0" stored as literal "0", missing values as "" or absent; a dam
//         whose every field is "" or a dash is provider-marked empty.
// License: 山形県 published; public site with no stated restriction.
//
// Priority 308, matching other 防災Web prefectural sources (fukui-bousai).

import { type Cell, cell, cellState, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const DATA_URL =
  process.env.YAMAGATA_BOUSAI_URL ??
  'http://www.kasen.pref.yamagata.jp/map/servlet/bousaiweb.servletBousaiMap?dk=4';

const PREF_CODE = '06';
const SOURCE_ID = 'yamagata-bousai';

// --- types ------------------------------------------------------------------

interface DamEntry {
  an: string; // dam name
  data1: string; // water level EL.m
  data2: string; // storage 千m³
  data3: string; // inflow m³/s
  data4: string; // outflow m³/s
  data5: string; // storage rate %
  time: string; // per-dam timestamp YYYYMMDDHHMMSS
  [key: string]: string;
}

export interface YamagataJson {
  date: string; // feed timestamp YYYYMMDDHHMMSS
  [key: string]: DamEntry | string;
}

// --- parsing ----------------------------------------------------------------

/** "" and the dashes are the feed's own blank; an absent field is unreadable. */
function parseNum(s: string | undefined): Cell {
  if (s === undefined) return null;
  const cleaned = s.replace(/[,\s　]/g, '');
  if (!cleaned || cleaned === '---' || cleaned === '-' || cleaned === '―') return cell(null, true);
  return cell(Number(cleaned), false);
}

/** "YYYYMMDDHHMMSS" JST → UTC Date */
export function parseYamagataTimestamp(s: string): Date | null {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [yr, mo, dy, hr, mi] = m.slice(1, 6).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const d = new Date(Date.UTC(yr, mo - 1, dy, hr - 9, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

function damReading(entry: DamEntry, feedDate: string): Reading {
  const level = parseNum(entry.data1);
  const storageThou = parseNum(entry.data2);
  const inflow = parseNum(entry.data3);
  const outflow = parseNum(entry.data4);
  const rate = parseNum(entry.data5);
  const state = cellState([level, storageThou, inflow, outflow, rate]);
  if (state === 'empty') return { state, mark: 'blank or dash in every field' };
  if (state === 'unreadable') return { state, why: 'no numeric field' };
  // Use per-dam timestamp when available, fall back to feed-level date.
  const tsStr = entry.time?.trim() || feedDate;
  const observedAt = parseYamagataTimestamp(tsStr);
  if (!observedAt) return { state: 'unreadable', why: `time "${tsStr}"` };
  const thou = numberIn(storageThou);
  const ratePct = numberIn(rate);
  return {
    state: 'values',
    observations: [
      {
        observedAt,
        waterLevelM: numberIn(level),
        storageVolumeM3: thou !== null ? thou * 1_000 : null,
        storageRate: ratePct !== null ? ratePct / 100 : null,
        inflowM3s: numberIn(inflow),
        outflowM3s: numberIn(outflow),
      },
    ],
  };
}

/** One entry per named dam, keyed by its name (the stamp this source has always used). */
export function yamagataEntries(json: YamagataJson): Entry[] {
  const out: Entry[] = [];
  for (const [key, val] of Object.entries(json)) {
    if (key === 'date') continue;
    if (typeof val !== 'object') continue;
    const name = val.an?.trim();
    if (!name) continue;
    // The master files a 貯水池 under its bare name.
    const bare = name.replace(/貯水池$/, '');
    out.push({
      key: name,
      name,
      pref: PREF_CODE,
      ...(bare !== name ? { bind: { name: bare } } : {}),
      reading: damReading(val, json.date),
    });
  }
  return out;
}

// --- task -------------------------------------------------------------------

export default ingestTask(SOURCE_ID, async (log) => {
  const r = await fetch(DATA_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) throw new Error(`${SOURCE_ID}: HTTP ${r.status}`);

  const text = new TextDecoder('shift_jis').decode(await r.arrayBuffer());
  const entries = yamagataEntries(JSON.parse(text) as YamagataJson);
  log(`${SOURCE_ID}: ${entries.length} dams`);
  return { entries };
});
