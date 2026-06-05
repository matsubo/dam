// apps/worker/src/tasks/ingest_ehime_bousai.ts
//
// 愛媛県 河川砂防総合情報システム ダム諸量現況表 — 県管理ダム hourly.
//
// Source:
//   https://kasen.pref.ehime.jp/pc/servlet/bousaiweb.servletBousaiTableStatus
//   ?sv=3&dk=4
//   (Shift_JIS HTML; standard 防災Web table; no session required)
//
// NOTE: This URL is accessible only from Japanese IP addresses. From outside
//   Japan the server returns a connection refused (HTTP 000). The adapter will
//   work normally from the production server in Japan.
//
// Coverage: prefecture-managed dams in Ehime (38). National dams in the area
//   (野村/鹿野川 via skr-hiji-dam, 富郷/柳瀬 via jwa-yoshino) are already
//   covered; this adapter adds the remaining pref-managed dams.
//
// Priority 308. Cron hourly at :57.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import type { Task } from 'graphile-worker';

import { parseBousaiWebTable } from './ingest_shizuoka_bousai.ts';

const DATA_URL =
  process.env.EHIME_BOUSAI_URL ??
  'https://kasen.pref.ehime.jp/pc/servlet/bousaiweb.servletBousaiTableStatus?sv=3&dk=4';

const PREF_CODE = '38';
const SOURCE_ID = 'ehime-bousai';

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '愛媛県河川砂防総合情報システム ダム諸量現況表 — 防災Web HTML table, hourly',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

function normalizeName(s: string): string {
  return s
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/ダム$/, '')
    .replace(/貯水池$/, '')
    .trim();
}

interface DamMatch {
  damName: string;
  damId: bigint;
}

async function matchMaster(
  rows: { damName: string }[],
  log: (s: string) => void,
): Promise<DamMatch[]> {
  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];

  for (const r of rows) {
    const stem = normalizeName(r.damName);
    if (!stem) continue;

    let best: { id: bigint; rank: number } | null = null;
    for (const m of masters) {
      const mStem = normalizeName(m.name);
      let rank: number;
      if (m.name === r.damName) rank = 0;
      else if (mStem === stem) rank = 1;
      else if (m.name === `${stem}ダム`) rank = 2;
      else if (mStem.startsWith(stem)) rank = 3;
      else if (mStem.includes(stem)) rank = 4;
      else continue;
      if (!best || rank < best.rank || (rank === best.rank && m.id < best.id)) {
        best = { id: m.id, rank };
      }
    }

    if (!best) {
      log(`${SOURCE_ID}: no master match for "${r.damName}"`);
      continue;
    }
    out.push({ damName: r.damName, damId: best.id });
  }

  return out;
}

// --- task -------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const r = await fetch(DATA_URL, {
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

  const raw = await r.arrayBuffer();
  const html = new TextDecoder('shift_jis').decode(raw);
  const rows = parseBousaiWebTable(html);
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);

  const matches = await matchMaster(rows, log);
  const damByName = new Map(matches.map((m) => [m.damName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByName.get(p.damName);
    if (!damId) continue;
    if (!p.observedAt) {
      log(`${SOURCE_ID}: missing timestamp for "${p.damName}"; skipping`);
      continue;
    }

    inputs.push({
      observedAt: p.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: p.storageVolumeM3,
      storageRate: p.storageRate,
      inflowM3s: p.inflowM3s,
      outflowM3s: p.outflowM3s,
      waterLevelM: p.waterLevelM,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }

  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: parsed=${rows.length} matched=${matches.length} written=${written}`);
};

export default task;
