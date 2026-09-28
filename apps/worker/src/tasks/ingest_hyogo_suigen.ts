// apps/worker/src/tasks/ingest_hyogo_suigen.ts
//
// 兵庫県 企画部 総合政策課「県内の水源の状況」 — 県内主要水源の貯水率, monthly.
//
// Source: https://web.pref.hyogo.lg.jp/kk05/ac07_000000162.html. Static UTF-8
// HTML, one table.datatable captioned 【令和8年9月1日現在】, columns
//   ダム名 | 所在地 | 用途 | 貯水率 | 貯水率（10か年平均）
// The page says 「通常時は月1回程度、渇水が予測される場合は頻度を高めて」: the
// survey is the 1st of the month (published ~10 days later) and in a 渇水 the
// table grows (2025-08: 大路/但東/三宝/栗柄 added, 呑吐 and 大川瀬 split, and a
// 取水制限 notice table above it). The date carries no time, so a survey is
// stamped 00:00 JST; the daily poll re-writes the same row until it changes.
//
// Rate only (integer %); no volume or level is published. The rates are the
// managers' own, not volume ÷ ダム便覧 有効: on 2026-09-01 the page's 一庫 100 %
// equals jwa-junpo's native 1.0000 at 00:00 JST while 14,004 千m³ is 45.5 % of
// 有効 30,800; 青野 prints 89 % against 58.4 % of 有効. 淡路広域水道企業団's
// own table (awaji-suido.jp/osirase-01.html, 2024–2026) back-solves the 淡路
// dams: 猪鼻第2 479,200 / 100 % = 479 千m³ (master 有効 479), 猪鼻第1 311,300 /
// 100.1 % = 311 (master 304), 竹原 525,200 / 100.7 % = 522 against master 618 —
// a full 竹原 reads 100 % here. The rate is kept anyway: it is the manager's
// fullness of the dam's whole 水道 pool, not one user's share. With no volume
// there is nothing for trusted_rate_basis to back-solve, so the source stays
// untrusted (0048).
//
// Written: 千苅/丸山/加古川大堰, which have no other feed, and 鴨川 (plus 呑吐,
// 大川瀬 and 但東 when a 渇水 layout lists them apart), whose only feeds carry
// the level and no storage (kasenbosai, hyogo-bodik; prod 2026-09-28). Rows
// whose dam another feed carries with volumes go to the universe only: this
// rate-only monthly row would otherwise become the latest observation and
// blank the dam page's volume, or drop into a computed rate series as a spike.
// That includes 竹原/猪ノ鼻/猪鼻第2, for which awaji-suido writes volumes. The
// row pairing 呑吐 and 大川瀬 has one figure for two dams and stays unresolved.
//
// Priority 287. Cron daily 01:17 UTC (10:17 JST).

import { type BindableMaster, preferMaster, stampedMaster } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const PAGE_URL =
  process.env.HYOGO_SUIGEN_URL ?? 'https://web.pref.hyogo.lg.jp/kk05/ac07_000000162.html';

const PREF_CODE = '28';
const SOURCE_ID = 'hyogo-suigen';

// Rows whose dam another feed already carries with a storage volume (checked on
// prod 2026-09-28). Keyed by the page's name, furigana stripped.
const COVERED_ELSEWHERE: Record<string, true> = {
  // kasenbosai / hyogo-bodik / jwa-junpo, every 10 minutes.
  青野ダム: true,
  一庫ダム: true,
  生野ダム: true,
  大路ダム: true,
  三宝ダム: true,
  栗柄ダム: true,
  成相ダム: true,
  牛内ダム: true,
  // awaji-suido (淡路広域水道企業団 各水源地の貯水状況) publishes their volumes.
  竹原ダム: true,
  猪ノ鼻ダム: true,
  猪ノ鼻第二ダム: true,
};

// --- parsing ----------------------------------------------------------------

export interface ParsedRow {
  /** Page name, furigana stripped; dams sharing a row joined by 「・」. Stamp and universe key. */
  name: string;
  /** The dams the row covers — more than one when a row pairs two dams. */
  damNames: string[];
  /** 貯水率 as a 0..1 fraction; null for a missing marker. */
  storageRate: number | null;
}

export interface ParsedPage {
  /** The 【…現在】 survey date at 00:00 JST, or null when the caption is missing. */
  observedAt: Date | null;
  rows: ParsedRow[];
}

/** Tag-free, NFKC-folded, whitespace-free text. */
function flat(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, '')
    .normalize('NFKC')
    .replace(/\s+/g, '');
}

export function parseHyogoSuigen(html: string): ParsedPage {
  const table = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)]
    .map((m) => m[1] ?? '')
    .find((body) => /<th[^>]*>\s*ダム名\s*<\/th>/.test(body));
  if (!table) return { observedAt: null, rows: [] };

  const d = flat(table.match(/<caption[^>]*>([\s\S]*?)<\/caption>/)?.[1] ?? '').match(
    /令和(\d+|元)年(\d{1,2})月(\d{1,2})日現在/,
  );
  const observedAt = d
    ? new Date(
        Date.UTC(2018 + (d[1] === '元' ? 1 : Number(d[1])), Number(d[2]) - 1, Number(d[3]), -9),
      )
    : null;

  const rows: ParsedRow[] = [];
  for (const tr of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...(tr[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1] ?? '');
    if (cells.length < 4) continue;
    // A shared row puts each dam in its own <p> (or line) of the name cell.
    const damNames = (cells[0] ?? '')
      .split(/<\/p>|<br\s*\/?>/)
      .map((part) => flat(part).replace(/[(（][^)）]*[)）]/g, ''))
      .filter((n) => n !== '');
    if (damNames.length === 0) continue;
    const pct = flat(cells[3] ?? '').match(/^(\d+(?:\.\d+)?)%$/)?.[1];
    rows.push({
      name: damNames.join('・'),
      damNames,
      storageRate: pct === undefined ? null : Number(pct) / 100,
    });
  }
  return { observedAt, rows };
}

// --- matching ---------------------------------------------------------------

/** 猪ノ鼻（いのはな）第二ダム and master 猪鼻第2 fold to the same 猪鼻第2. */
function fold(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/[(（][^)）]*[)）]/g, '')
    .replace(/ダム$/, '')
    .replace(/[ノの]/g, '')
    .replace(/第二/g, '第2')
    .trim();
}

/** The stamped row, else the master whose folded name is the page's. */
export function chooseMaster(name: string, masters: BindableMaster[]): bigint | null {
  const stamped = stampedMaster(masters, name);
  if (stamped) return stamped.id;
  const key = fold(name);
  let best: BindableMaster | null = null;
  for (const m of masters) {
    if (fold(m.name) !== key) continue;
    if (!best || preferMaster(m, best)) best = m;
  }
  return best?.id ?? null;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 287,
            '兵庫県 総合政策課 県内の水源の状況 — 主要水源の貯水率 (月1回程度, HTML)',
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

  const { observedAt, rows } = parseHyogoSuigen(await r.text());
  log(`${SOURCE_ID}: parsed ${rows.length} rows for ${observedAt?.toISOString() ?? 'no date'}`);

  const masters = await sql<BindableMaster[]>`
    SELECT id, name, completed_year AS "completedYear", external_ids->>${SOURCE_ID} AS stamp
    FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;

  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];
  const inputs = [] as Parameters<typeof upsertObservations>[0];
  let matched = 0;
  for (const p of rows) {
    // One figure for two dams belongs to neither.
    const damId = p.damNames.length === 1 ? chooseMaster(p.name, masters) : null;
    universe.push({ externalId: p.name, name: p.name, prefCode: PREF_CODE, resolvedDamId: damId });
    if (!damId) {
      log(`${SOURCE_ID}: no master for "${p.name}"`);
      continue;
    }
    matched++;
    await bindExternalId(damId, SOURCE_ID, p.name);
    if (COVERED_ELSEWHERE[p.name] || p.storageRate === null || !observedAt) continue;
    inputs.push({
      observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: null,
      storageRate: p.storageRate,
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
  log(`${SOURCE_ID} done: parsed=${rows.length} matched=${matched} written=${written}`);

  if (rows.length === 0 || !observedAt) {
    throw new Error(
      `${SOURCE_ID}: ${rows.length} rows, date ${observedAt ? 'found' : 'missing'} on ${PAGE_URL} — layout change?`,
    );
  }
};

export default task;
