// apps/worker/src/index.ts
import { run } from 'graphile-worker';
import { CRONTAB } from './crontab.ts';
import backfillJwaJunpo from './tasks/backfill_jwa_junpo.ts';
import backfillKagoshima from './tasks/backfill_kagoshima_bodik.ts';
import backfillMudam from './tasks/backfill_mudam.ts';
import backfillEnqueue from './tasks/backfill_suimon_enqueue.ts';
import backfillRun from './tasks/backfill_suimon_run.ts';
import ingestAichiKasen from './tasks/ingest_aichi_kasen.ts';
import ingestAitoyo from './tasks/ingest_aitoyo.ts';
import ingestAkita from './tasks/ingest_akita_kasen.ts';
import ingestAomori from './tasks/ingest_aomori.ts';
import ingestCgrMlit from './tasks/ingest_cgr_mlit.ts';
import ingestChiba from './tasks/ingest_chiba.ts';
import ingestFukuiBousai from './tasks/ingest_fukui_bousai.ts';
import ingestFukuokaBodik from './tasks/ingest_fukuoka_bodik.ts';
import ingestGifuKasen from './tasks/ingest_gifu_kasen.ts';
import ingestHiroshima from './tasks/ingest_hiroshima.ts';
import ingestHkdMlit from './tasks/ingest_hkd_mlit.ts';
import ingestHrrMlit from './tasks/ingest_hrr_mlit.ts';
import ingestHyogo from './tasks/ingest_hyogo.ts';
import ingestIbaraki from './tasks/ingest_ibaraki_bousai.ts';
import ingestIshikawa from './tasks/ingest_ishikawa_kasen.ts';
import ingestIwate from './tasks/ingest_iwate_kasen.ts';
import ingestJwaChikugo from './tasks/ingest_jwa_chikugo.ts';
import ingestJwaChubu from './tasks/ingest_jwa_chubu.ts';
import ingestJwaJunpo from './tasks/ingest_jwa_junpo.ts';
import ingestJwaKisoRt from './tasks/ingest_jwa_kiso_rt.ts';
import ingestJwaToneAra from './tasks/ingest_jwa_toneara.ts';
import ingestJwaToyokawa from './tasks/ingest_jwa_toyokawa.ts';
import ingestJwaYoshino from './tasks/ingest_jwa_yoshino.ts';
import ingestKanagawa from './tasks/ingest_kanagawa.ts';
import ingestKasenbosai from './tasks/ingest_kasenbosai.ts';
import ingestKasenbosaiV2 from './tasks/ingest_kasenbosai_v2.ts';
import ingestKkrMlit from './tasks/ingest_kkr_mlit.ts';
import ingestKtrKinu from './tasks/ingest_ktr_kinu.ts';
import ingestKtrTone from './tasks/ingest_ktr_tone_dam.ts';
import ingestKumamoto from './tasks/ingest_kumamoto_bousai.ts';
import ingestMiyagi from './tasks/ingest_miyagi_kasen.ts';
import ingestMiyazaki from './tasks/ingest_miyazaki_bousai.ts';
import ingestNagasaki from './tasks/ingest_nagasaki_kasen.ts';
import ingestNaraKasen from './tasks/ingest_nara_kasen.ts';
import ingestNiigata from './tasks/ingest_niigata.ts';
import ingestOita from './tasks/ingest_oita_bousai.ts';
import ingestOkayama from './tasks/ingest_okayama.ts';
import ingestOsaka from './tasks/ingest_osaka.ts';
import ingestQsrTuruta from './tasks/ingest_qsr_turuta.ts';
import ingestShiga from './tasks/ingest_shiga.ts';
import ingestShimaneBousai from './tasks/ingest_shimane_bousai.ts';
import ingestShimokubo from './tasks/ingest_shimokubo.ts';
import ingestTochigi from './tasks/ingest_tochigi.ts';
import ingestTokushima from './tasks/ingest_tokushima_bousai.ts';
import ingestTokyoWaterworks from './tasks/ingest_tokyo_waterworks.ts';
import ingestTottori from './tasks/ingest_tottori.ts';
import ingestTottoriBousai from './tasks/ingest_tottori_bousai.ts';
import ingestToyamaBousai from './tasks/ingest_toyama_bousai.ts';
import ingestYamagata from './tasks/ingest_yamagata_bousai.ts';
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
      'ingest:jwa-toneara': ingestJwaToneAra,
      'ingest:jwa-chubu': ingestJwaChubu,
      'ingest:jwa-toyokawa': ingestJwaToyokawa,
      'ingest:jwa-kiso-rt': ingestJwaKisoRt,
      'ingest:jwa-yoshino': ingestJwaYoshino,
      'ingest:aitoyo': ingestAitoyo,
      'ingest:jwa-chikugo': ingestJwaChikugo,
      'ingest:kanagawa-dam': ingestKanagawa,
      'ingest:kumamoto-bousai': ingestKumamoto,
      'ingest:kkr-mlit-dam': ingestKkrMlit,
      'ingest:shiga-bousai': ingestShiga,
      'ingest:tottori-dam': ingestTottori,
      'ingest:akita-kasen': ingestAkita,
      'ingest:aomori-dam': ingestAomori,
      'ingest:hkd-mlit-dam': ingestHkdMlit,
      'ingest:cgr-mlit-dam': ingestCgrMlit,
      'ingest:ktr-kinu-dam': ingestKtrKinu,
      'ingest:ktr-tone-dam': ingestKtrTone,
      'ingest:qsr-turuta-dam': ingestQsrTuruta,
      'ingest:hrr-mlit-dam': ingestHrrMlit,
      'ingest:chiba-suisei': ingestChiba,
      'ingest:okayama-bousai': ingestOkayama,
      'ingest:niigata-bousai': ingestNiigata,
      'ingest:oita-bousai': ingestOita,
      'ingest:hyogo-bodik': ingestHyogo,
      'ingest:tochigi-bodik': ingestTochigi,
      'ingest:tokushima-bousai': ingestTokushima,
      'ingest:hiroshima-bousai': ingestHiroshima,
      'ingest:osaka-bousai': ingestOsaka,
      'ingest:tottori-bousai': ingestTottoriBousai,
      'ingest:shimane-bousai': ingestShimaneBousai,
      'ingest:shimokubo': ingestShimokubo,
      'ingest:ibaraki-bousai': ingestIbaraki,
      'ingest:ishikawa-kasen': ingestIshikawa,
      'ingest:iwate-kasen': ingestIwate,
      'ingest:miyagi-kasen': ingestMiyagi,
      'ingest:miyazaki-bousai': ingestMiyazaki,
      'ingest:nagasaki-kasen': ingestNagasaki,
      'ingest:yamagata-bousai': ingestYamagata,
      'ingest:fukuoka-bodik': ingestFukuokaBodik,
      'ingest:gifu-kasen': ingestGifuKasen,
      'ingest:aichi-kasen': ingestAichiKasen,
      'ingest:fukui-bousai': ingestFukuiBousai,
      'ingest:toyama-bousai': ingestToyamaBousai,
      'ingest:nara-kasen': ingestNaraKasen,
      'backfill:kagoshima-bodik': backfillKagoshima,
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
