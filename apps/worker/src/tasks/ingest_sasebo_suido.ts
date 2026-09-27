// apps/worker/src/tasks/ingest_sasebo_suido.ts
//
// 佐世保市水道局「佐世保市水道用貯水池の貯水状況表」 — 6 reservoirs, daily.
//
//   中部水系 山の田 / 菰田 / 川谷 / 相当 / 転石, 南部水系 下の原
//
// Source: https://www.city.sasebo.lg.jp/suidokyoku/suisou/chosuiritsu.html
// The page shows only the city-wide rate and links the per-dam report as a
// PDF whose name carries the 令和 date (suiryounippou080927.pdf = R8.9.27), so
// the link is discovered each run, never pinned. A new report appears every
// day including weekends (the R8.9.27 one is a Sunday, Last-Modified 08:22 JST).
//
// Format: one table per PDF, one line per dam once unpdf extracts it:
//   山の田 551 千ｍ 3 479,184 m 3 87.0% m 3 92.5mm 551,000 m 3 100.0%
//   = ダム名 有効貯水量(千m³) 現在貯水量(m³) 貯水率 [前日増減 降雨量 前年同日]
// The 前日との比較増減 volumes are extracted elsewhere in reading order, which
// is why the line jumps from 87.0% to a bare "m 3". 小計 / 合計 rows are not
// dams. The header 「令和8年9月27日 (日)現在」 plus the footnote 「このデータは
// 午前０時ごろのデータです」 date the whole table at 00:00 JST.
//
// Rate: 貯水率 = 現在貯水量 / the 有効貯水量 printed on the same line, which is
// the city's 水道 pool. Back-solved from the R8.9.27 report against the master:
//   山の田 479,184 / 87.0 % = 551 千m³ (master 有効 551), 相当 383,516 / 95.9 %
//   = 400 (400), 下の原 1,355,400 / 62.1 % = 2,183 (2,182),
//   川谷 1,310,523 / 81.4 % = 1,610 (master 有効 1,910 — 川谷 is 農業+水道, and
//   the city divides by its own 1,610 share).
// So the rate is the manager's own basis and is trusted in 0098; without that
// 川谷 would be shown at 68.6 % instead of the city's 81.4 %.
//
// Priority 300: no other feed publishes these 6 dams. Cron 01:54 and 07:54 UTC
// (10:54 / 16:54 JST), the second run catching a late upload.

import { type BindableMaster, preferMaster, stampedMaster } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';
import { extractText, getDocumentProxy } from 'unpdf';

const INDEX_URL =
  process.env.SASEBO_SUIDO_URL ??
  'https://www.city.sasebo.lg.jp/suidokyoku/suisou/chosuiritsu.html';

const ORIGIN = 'https://www.city.sasebo.lg.jp';
const PREF_CODE = '42';
const SOURCE_ID = 'sasebo-suido';

// --- parsing ----------------------------------------------------------------

export interface ParsedRow {
  /** ダム名 as printed ("下の原"); also the stamp and universe key. */
  name: string;
  /** 現在貯水量 in m³. */
  storageVolumeM3: number;
  /** 貯水率 as a 0..1 fraction. */
  storageRate: number;
}

/** Extract the PDF's text with unpdf (no poppler in the runtime image). */
export async function pdfToText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

/** A dam line: name, 有効貯水量 千m³, 現在貯水量 m³, 貯水率 %. */
const ROW_RE = /([^\s\d,.%]\S*)\s+[\d,]+\s*千m\s*3?\s+([\d,]+)\s*m\s*3?\s+(\d+(?:\.\d+)?)%/;
/** Any line that names a dam with its 有効貯水量, whatever its readings say. */
const NAME_RE = /([^\s\d,.%]\S*)\s+[\d,]+\s*千m/;
const NOT_A_DAM = /^(小計|合計|計)$/;

export function parseSaseboPdfText(text: string): {
  reportDate: Date | null;
  rows: ParsedRow[];
  published: string[];
} {
  const normalized = text.normalize('NFKC');
  const rows: ParsedRow[] = [];
  const published: string[] = [];
  for (const line of normalized.split('\n')) {
    const name = line.match(NAME_RE)?.[1];
    if (!name || NOT_A_DAM.test(name)) continue;
    published.push(name);
    const m = line.match(ROW_RE);
    if (!m || m[1] !== name) continue;
    rows.push({
      name,
      storageVolumeM3: Number((m[2] ?? '').replace(/,/g, '')),
      storageRate: Number(m[3]) / 100,
    });
  }

  const d = normalized.match(/令和\s*(\d+)\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  // 令和 N → 2018 + N; the readings are 00:00 JST that day.
  const reportDate = d
    ? new Date(Date.UTC(2018 + Number(d[1]), Number(d[2]) - 1, Number(d[3]), -9))
    : null;
  return { reportDate, rows, published };
}

/** The newest daily report linked from the page (by the R-yymmdd in its name). */
export function findLatestPdfUrl(html: string): string | null {
  let best: { path: string; stamp: number } | null = null;
  for (const m of html.matchAll(/\/documents\/\d+\/suiryounippou(\d{6})\.pdf/g)) {
    const stamp = Number(m[1]);
    if (!best || stamp > best.stamp) best = { path: m[0], stamp };
  }
  return best ? `${ORIGIN}${best.path}` : null;
}

// --- matching ---------------------------------------------------------------

function stemOf(s: string): string {
  return s
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/ダム$/, '')
    .trim();
}

/** The stamped row, else the dam of the same name (live twin of （元）/（再）). */
export function chooseMaster(name: string, masters: BindableMaster[]): bigint | null {
  const stamped = stampedMaster(masters, name);
  if (stamped) return stamped.id;
  const stem = stemOf(name);
  let best: BindableMaster | null = null;
  for (const m of masters) {
    if (stemOf(m.name) !== stem) continue;
    if (!best || preferMaster(m, best)) best = m;
  }
  return best?.id ?? null;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 300,
            '佐世保市水道局 水道用貯水池の貯水状況表 — 6 ダム (日次 PDF, 貯水量+貯水率)',
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

  const headers = {
    'user-agent':
      process.env.HTTP_USER_AGENT ??
      'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
  };

  const indexRes = await fetch(INDEX_URL, { headers, signal: AbortSignal.timeout(20_000) });
  if (indexRes.status !== 200) {
    log(`${SOURCE_ID}: index HTTP ${indexRes.status}; aborting`);
    return;
  }
  const pdfUrl = findLatestPdfUrl(await indexRes.text());
  if (!pdfUrl) {
    throw new Error(`${SOURCE_ID}: no suiryounippou PDF linked from ${INDEX_URL} — layout change?`);
  }

  const pdfRes = await fetch(pdfUrl, { headers, signal: AbortSignal.timeout(30_000) });
  if (pdfRes.status !== 200) {
    log(`${SOURCE_ID}: PDF HTTP ${pdfRes.status} for ${pdfUrl}; aborting`);
    return;
  }

  const text = await pdfToText(new Uint8Array(await pdfRes.arrayBuffer()));
  const { reportDate, rows, published } = parseSaseboPdfText(text);
  if (!reportDate) {
    throw new Error(`${SOURCE_ID}: no 令和 date in ${pdfUrl} — layout change?`);
  }
  log(
    `${SOURCE_ID}: parsed ${rows.length}/${published.length} dams for ${reportDate.toISOString()}`,
  );

  const masters = await sql<BindableMaster[]>`
    SELECT id, name, completed_year AS "completedYear", external_ids->>${SOURCE_ID} AS stamp
    FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;

  const damByName = new Map<string, bigint>();
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];
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
      observedAt: reportDate,
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

  // Line-oriented parsing over extracted PDF text fails silently on a layout
  // change: names still found, no readings. Throwing surfaces it in failing_jobs.
  if (published.length > 0 && rows.length === 0) {
    throw new Error(`${SOURCE_ID}: ${published.length} dams listed but no readings in ${pdfUrl}`);
  }
};

export default task;
