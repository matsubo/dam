// apps/worker/src/index.ts
import { run } from 'graphile-worker';
import { CRONTAB } from './crontab.ts';
import backfillJwaJunpo from './tasks/backfill_jwa_junpo.ts';
import backfillMudam from './tasks/backfill_mudam.ts';
import backfillEnqueue from './tasks/backfill_suimon_enqueue.ts';
import backfillRun from './tasks/backfill_suimon_run.ts';
import ingestAitoyo from './tasks/ingest_aitoyo.ts';
import ingestAomori from './tasks/ingest_aomori.ts';
import ingestCgrMlit from './tasks/ingest_cgr_mlit.ts';
import ingestHkdMlit from './tasks/ingest_hkd_mlit.ts';
import ingestHrrMlit from './tasks/ingest_hrr_mlit.ts';
import ingestJwaChikugo from './tasks/ingest_jwa_chikugo.ts';
import ingestJwaJunpo from './tasks/ingest_jwa_junpo.ts';
import ingestKanagawa from './tasks/ingest_kanagawa.ts';
import ingestKasenbosai from './tasks/ingest_kasenbosai.ts';
import ingestKasenbosaiV2 from './tasks/ingest_kasenbosai_v2.ts';
import ingestKtrKinu from './tasks/ingest_ktr_kinu.ts';
import ingestShiga from './tasks/ingest_shiga.ts';
import ingestTokyoWaterworks from './tasks/ingest_tokyo_waterworks.ts';
import ingestTottori from './tasks/ingest_tottori.ts';
import match from './tasks/master_match.ts';
import refreshDamnet from './tasks/master_refresh_damnet.ts';
import refreshNdi from './tasks/master_refresh_ndi.ts';
import matchKasenbosai from './tasks/match_kasenbosai.ts';
import qualityFreshness from './tasks/quality_freshness.ts';
import qualityRecompute from './tasks/quality_recompute.ts';
import refreshDamElevation from './tasks/refresh_dam_elevation.ts';
import refreshDamImagesDamnet from './tasks/refresh_dam_images_damnet.ts';
import refreshDamImagesWikipedia from './tasks/refresh_dam_images_wikipedia.ts';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const runner = await run({
    connectionString: url,
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? '4'),
    noHandleSignals: false,
    pollInterval: 5_000,
    crontab: CRONTAB,
    taskList: {
      'master:refresh:ndi': refreshNdi,
      'master:refresh:damnet': refreshDamnet,
      'master:match': match,
      'match:kasenbosai': matchKasenbosai,
      'ingest:kasenbosai': ingestKasenbosai,
      'ingest:kasenbosai-v2': ingestKasenbosaiV2,
      'ingest:tokyo-waterworks': ingestTokyoWaterworks,
      'ingest:jwa-junpo': ingestJwaJunpo,
      'ingest:aitoyo': ingestAitoyo,
      'ingest:jwa-chikugo': ingestJwaChikugo,
      'ingest:kanagawa-dam': ingestKanagawa,
      'ingest:shiga-bousai': ingestShiga,
      'ingest:tottori-dam': ingestTottori,
      'ingest:aomori-dam': ingestAomori,
      'ingest:hkd-mlit-dam': ingestHkdMlit,
      'ingest:cgr-mlit-dam': ingestCgrMlit,
      'ingest:ktr-kinu-dam': ingestKtrKinu,
      'ingest:hrr-mlit-dam': ingestHrrMlit,
      'backfill:suimon:enqueue': backfillEnqueue,
      'backfill:suimon:run': backfillRun,
      'backfill:jwa-junpo': backfillJwaJunpo,
      'backfill:mudam': backfillMudam,
      'quality:recompute': qualityRecompute,
      'quality:freshness-check': qualityFreshness,
      'images:refresh:damnet': refreshDamImagesDamnet,
      'images:refresh:wikipedia': refreshDamImagesWikipedia,
      'master:refresh:elevation': refreshDamElevation,
    },
  });

  await runner.promise;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
