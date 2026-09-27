// apps/worker/src/tasks/ingest_cgr_okakawa.ts
//
// 国土交通省 中国地方整備局 岡山河川事務所「三水系の主要ダムの貯水状況」—
// 吉井川・旭川・高梁川の主要 11 ダム + 2 堰, daily 午前9時 速報値.
//
// Source (linked from kouhou/kassui/kassui-top-new.html, and by 岡山県河川課's
// 渇水情報 page):
//   https://www.cgr.mlit.go.jp/okakawa/kouhou/kassui/kassui_pdf/3kasenndamukeika.pdf
// A fixed URL overwritten in place each weekday (Last-Modified 2026-09-25
// 09:45 JST for the 09:00 edition). Licence: 公共データ利用規約（第1.0版）
// (okakawa/policy/policy.html).
//
// Why this source: it is the only public, machine-readable publisher found for
// 小阪部川ダム (中国四国農政局, 15.1 百万m³) and 坂根堰 (岡山河川事務所) — both
// absent from おかやま防災ポータル and 川の防災情報's dam list. The other nine
// dams are already hourly through kasenbosai / okayama-bousai / cgr-mlit-dam;
// they are ingested too (the priority keeps the hourly feeds on the chart) so
// the published universe is complete.
//
// Format: PDF, three tables (one per 水系), each headed
//   「(2026年9月25日 午前９時現在）」
// and rows of 「ダム名 利水容量 貯水量 貯水率 前日との増減」 in 千m³ / %.
// Names are letter-spaced (「千 屋 ダ ム」,「坂 根 堰」). unpdf does not keep
// every row in column order — 湯原 comes out as「51.5 -112湯 原 ダ ム 72,000
// 37,064」— so the parser anchors on the name, takes 利水容量 and 貯水量 as the
// first two figures after it, and accepts as the rate only a printed figure on
// that line equal to 貯水量 / 利水容量. A row that has none is dropped, so a
// side note on the same line (「６つのダムの貯水率は 25.0 ％です。」) or a
// misread can never become a reading.
//
// Rate: 「※ 貯水率は洪水期利水容量に対する貯水量の比率」. Back-solving
// volume/rate returns the PDF's own 利水容量 column, which is below the
// annual 有効貯水容量 for most rows (苫田 28,100 vs 78,100; 湯原 72,000 vs
// 86,000) but *equal* to it for the two dams only this source covers
// (小阪部川 15,136 = 15,136; 坂根堰 1,600 = 1,600). Trusting it would change
// nothing where it wins the chart and would put a second trusted daily row next
// to kasenbosai / okayama-bousai elsewhere (0054's reason for leaving
// hkd-mlit-dam out), so it is NOT trusted_rate_basis. The rate is clamped at
// 1: the 洪水期 pool is printed year-round, so a 非洪水期 reading can exceed it.
//
// Priority 292 — below every hourly source on these dams (kasenbosai 310,
// okayama-bousai 309, cgr-mlit-dam 304) and above NILIM mudam (280, which
// carries 坂根堰 with a 1–2 year lag); no other source sits at 292.
// Cron: 01:50 and 05:50 UTC (10:50 / 14:50 JST), after the ~09:45 JST upload;
// the second run catches a late edition. Idempotent UPSERT on the PDF's own
// timestamp.

import { type BindableMaster, preferMaster, stampedMaster } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';
import { extractText, getDocumentProxy } from 'unpdf';

const PDF_URL =
  process.env.CGR_OKAKAWA_DAM_URL ??
  'https://www.cgr.mlit.go.jp/okakawa/kouhou/kassui/kassui_pdf/3kasenndamukeika.pdf';

const PREF_CODE = '33';
const SOURCE_ID = 'cgr-okakawa-dam';

/** Printed 貯水率 vs 貯水量 / 利水容量, in percentage points (千m³ rounding). */
const RATE_TOLERANCE_PCT = 0.5;

export interface ParsedRow {
  /** Name as printed with the letter-spacing removed, e.g. 「千屋ダム」. */
  name: string;
  observedAt: Date;
  /** 貯水量 in m³ (the PDF prints 千m³). */
  storageVolumeM3: number;
  /** 貯水率 against the 洪水期利水容量, 0..1. */
  storageRate: number;
}

// --- parsing ----------------------------------------------------------------

/**
 * 「(2026年9月25日 午前９時現在）」 → that instant (JST) as UTC. Full-width
 * digits are accepted; anchored on 現在 so no other date on the page stands in.
 */
export function parseOkakawaDate(s: string): Date | null {
  const m = s
    .normalize('NFKC')
    .match(
      /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日\s*(午前|午後)?\s*(\d{1,2})時(?:\s*(\d{1,2})分)?\s*現在/,
    );
  if (!m) return null;
  const hour = Number(m[5]) + (m[4] === '午後' && Number(m[5]) < 12 ? 12 : 0);
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour - 9, Number(m[6] ?? 0)),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * A dam or weir name — letter-spaced kanji/katakana ending in ダム or 堰 — at
 * the start of a line or straight after a figure (unpdf's reordered rows), and
 * followed by a figure. Headings (「主要ダム貯水量」) and side notes
 * (「３ダム、２堰の貯水率」) fail one of the two anchors.
 */
const NAME_RE = /(?:^|[\d\s])((?:[\p{sc=Han}\p{sc=Katakana}]\s?)+?(?:ダ\s?ム|堰))(?=\s+[\d,])/u;
const NUM_RE = /-?\d[\d,]*(?:\.\d+)?/g;

export function parseOkakawaPdfText(text: string): { rows: ParsedRow[]; published: string[] } {
  const rows: ParsedRow[] = [];
  const published: string[] = [];
  let observedAt: Date | null = null;

  for (const rawLine of text.normalize('NFKC').split(/\r?\n/)) {
    const line = rawLine.trim();
    observedAt = parseOkakawaDate(line) ?? observedAt;

    const nameMatch = NAME_RE.exec(line);
    const printed = nameMatch?.[1];
    if (!nameMatch || !printed) continue;
    const name = printed.replace(/\s+/g, '');
    if (!published.includes(name)) published.push(name);

    const nameAt = nameMatch.index + nameMatch[0].length - printed.length;
    const figures = (s: string) => (s.match(NUM_RE) ?? []).map((n) => Number(n.replace(/,/g, '')));
    const before = figures(line.slice(0, nameAt));
    const [capacity, volume, ...after] = figures(line.slice(nameAt + printed.length));
    if (!observedAt || capacity == null || volume == null || capacity <= 0 || volume < 0) continue;

    const implied = (100 * volume) / capacity;
    const pct = [after[0], ...before].find(
      (n) => n != null && Math.abs(n - implied) <= RATE_TOLERANCE_PCT,
    );
    if (pct == null) continue;

    rows.push({
      name,
      observedAt,
      storageVolumeM3: volume * 1_000,
      storageRate: Math.min(1, pct / 100),
    });
  }

  return { rows, published };
}

/**
 * Throw when a fetched PDF yields no usable row. Line-oriented parsing over
 * extracted text fails silently on a layout change — the names may still match
 * while no row survives the rate check, or (a notice PDF, a re-typeset table)
 * nothing matches at all — and either way the fetch is green. The PDF lists 13
 * rows every edition, so zero is never a legitimate reading; throwing surfaces
 * it in /api/v1/admin/jobs failing_jobs (#31).
 */
export function assertUsableRows(parsed: { rows: ParsedRow[]; published: string[] }): void {
  if (parsed.rows.length === 0) {
    throw new Error(
      `${SOURCE_ID}: 0 usable rows from ${parsed.published.length} published names — layout change?`,
    );
  }
}

/** Extract the PDF's text with unpdf (no poppler in the runtime image). */
export async function pdfToText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

// --- matching ---------------------------------------------------------------

function normalizeName(s: string): string {
  return s
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/ダム$/, '')
    .trim();
}

/**
 * Best pref-33 master for a printed name: the row already stamped with it
 * keeps it; otherwise an exact stem beats a prefix (苫田 over 苫田鞍部) beats
 * a substring, and equal ranks go to the live （元）/（再） twin.
 */
export function chooseMaster(name: string, masters: BindableMaster[]): bigint | null {
  const stamped = stampedMaster(masters, name);
  if (stamped) return stamped.id;
  const stem = normalizeName(name);
  if (!stem) return null;
  let best: { m: BindableMaster; rank: number } | null = null;
  for (const m of masters) {
    const mStem = normalizeName(m.name);
    let rank: number;
    if (mStem === stem) rank = 0;
    else if (mStem.startsWith(stem)) rank = 1;
    else if (mStem.includes(stem)) rank = 2;
    else continue;
    if (!best || rank < best.rank || (rank === best.rank && preferMaster(m, best.m))) {
      best = { m, rank };
    }
  }
  return best?.m.id ?? null;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 292,
            '国土交通省 中国地方整備局 岡山河川事務所 三水系主要ダム貯水状況 — 11 ダム + 2 堰, 平日 9時 (PDF)',
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

  const res = await fetch(PDF_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status !== 200) {
    log(`${SOURCE_ID}: HTTP ${res.status}; aborting`);
    return;
  }

  const { rows, published } = parseOkakawaPdfText(
    await pdfToText(new Uint8Array(await res.arrayBuffer())),
  );
  log(`${SOURCE_ID}: parsed ${rows.length}/${published.length} rows`);

  const masters = await sql<BindableMaster[]>`
    SELECT id, name, completed_year AS "completedYear", external_ids->>${SOURCE_ID} AS stamp
    FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];
  const damByName = new Map<string, bigint>();
  for (const name of published) {
    const damId = chooseMaster(name, masters);
    universe.push({ externalId: name, name, prefCode: PREF_CODE, resolvedDamId: damId });
    if (!damId) {
      log(`${SOURCE_ID}: no master match for "${name}"`);
      continue;
    }
    damByName.set(name, damId);
    await bindExternalId(damId, SOURCE_ID, name);
  }
  await recordUniverse(SOURCE_ID, universe);

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByName.get(p.name);
    if (!damId) continue;
    inputs.push({
      observedAt: p.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: p.storageVolumeM3,
      storageRate: p.storageRate,
      inflowM3s: null,
      outflowM3s: null,
      waterLevelM: null,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }
  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: parsed=${rows.length} matched=${damByName.size} written=${written}`);

  assertUsableRows({ rows, published });
};

export default task;
