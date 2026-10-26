// apps/worker/src/tasks/ingest_cgr_ashida_seki.ts
//
// 国土交通省 中国地方整備局 福山河川国道事務所 — 芦田川河口堰 (芦田川水系,
// 広島/34). The weir is a master dam row (NDI 1908, 有効貯水容量 4,960 千m³)
// that no other live source publishes; mudam only carries its 1-2 year old
// daily figures.
//
// Source: the office's 芦田川水系 水文データ page (mobile HTML, UTF-8 with BOM),
// a single snapshot refreshed every 10 minutes:
//   http://www.cgr.mlit.go.jp/fukuyama/mobile_ashidagawa/sekisyoryou.php
//
//   観測日時: YYYY/MM/DD<br>HH:MM   (JST)
//   ■ 芦田川河口堰諸量, one <tr> per item:
//     流入量   m³/s  → inflow
//     放流量   m³/s  → outflow
//     貯水量   千m³  → storage volume (× 1000 = m³)
//     堰上水位 m     → water level (the pool side of the weir)
//     堰下水位 / 堰取水量 — not stored
//   No 貯水率 is published; storage_rate stays NULL and is derived from the
//   volume like any other untrusted source.
//   A cell reading 欠測 or a dash is the office's own mark; the weir is
//   provider-marked empty when all four stored cells carry one.
//
// Licence: 中国地方整備局 site terms — 公共データ利用規約（第1.0版）(PDL1.0),
// 出典記載のうえ利用可 (www.cgr.mlit.go.jp/about_manual/).
//
// Priority 303 (MLIT office source, same as qsr-ryumon-dam). Cron hourly at :02.

import { type Cell, cell, cellState, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const PAGE_URL =
  process.env.CGR_ASHIDA_SEKI_URL ??
  'http://www.cgr.mlit.go.jp/fukuyama/mobile_ashidagawa/sekisyoryou.php';

const SOURCE_ID = 'cgr-ashida-seki';
const PREF_CODE = '34';
/** The page publishes one facility and no station code; its name is the key. */
const STATION = '芦田川河口堰';

/** The office's own "no value" marks. */
const MARK_RE = /^(?:欠測|[-－―ー−]+)$/;

function parseCell(s: string | undefined): Cell {
  const t = (s ?? '')
    .replace(/<[^>]+>|&nbsp;/g, '')
    .replace(/,/g, '')
    .trim();
  if (MARK_RE.test(t)) return cell(null, true);
  if (!/^-?\d+(?:\.\d+)?$/.test(t)) return null;
  return Number(t);
}

/** The 水文データ page's reading; unreadable when it carries no 観測日時. */
export function ashidaSekiReading(html: string): Reading {
  const ts = html.match(/観測日時:\s*(\d{4})\/(\d{2})\/(\d{2})\s*<br\s*\/?>\s*(\d{2}):(\d{2})/);
  if (!ts) return { state: 'unreadable', why: 'no 観測日時 on the page' };
  const observedAt = new Date(
    Date.UTC(Number(ts[1]), Number(ts[2]) - 1, Number(ts[3]), Number(ts[4]) - 9, Number(ts[5])),
  );

  const cells: Record<string, Cell> = {};
  for (const m of html.matchAll(
    /<td class="name">([^<]+)<\/td>\s*<td class="data"[^>]*>([\s\S]*?)<\/td>/g,
  )) {
    cells[(m[1] ?? '').trim()] = parseCell(m[2]);
  }
  const level = cells.堰上水位 ?? null;
  const inflow = cells.流入量 ?? null;
  const outflow = cells.放流量 ?? null;
  const storageThou = cells.貯水量 ?? null;

  const state = cellState([level, inflow, outflow, storageThou]);
  if (state === 'empty') return { state, mark: '欠測 on every stored cell' };
  if (state === 'unreadable') return { state, why: 'no numeric cell' };
  const thou = numberIn(storageThou);
  return {
    state: 'values',
    observations: [
      {
        observedAt,
        waterLevelM: numberIn(level),
        inflowM3s: numberIn(inflow),
        outflowM3s: numberIn(outflow),
        storageVolumeM3: thou !== null ? thou * 1000 : null,
      },
    ],
  };
}

/**
 * The one facility the page publishes, read once the run reaches it: a page
 * that fails to load leaves the weir unreadable rather than unlisted.
 */
export function ashidaSekiEntries(fetchPage: () => Promise<string>): Entry[] {
  return [
    {
      key: STATION,
      name: STATION,
      pref: PREF_CODE,
      reading: async () => ashidaSekiReading(await fetchPage()),
    },
  ];
}

async function fetchPage(): Promise<string> {
  const res = await fetch(PAGE_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export default ingestTask(SOURCE_ID, async () => ({ entries: ashidaSekiEntries(fetchPage) }));
