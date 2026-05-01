// apps/worker/src/tasks/backfill_suimon_run.ts
import { suimonAdapter } from '@dam/adapters-suimon';
import { complete, fail, startRunning } from '@dam/db/repo/backfill_progress';
import { upsertObservations } from '@dam/db/repo/observations';
import { markParsed, recordRawSnapshot } from '@dam/db/repo/raw_snapshots';
import { putSnapshot, rawSnapshotKey } from '@dam/storage/snapshot_store';
import type { Task } from 'graphile-worker';

const task: Task = async (_payload, helpers) => {
  // The adapter returns at most SUIMON_BATCH targets at a time.
  const ctx = { runAt: new Date() };
  const targets = await suimonAdapter.fetchTargets(ctx);
  let totalObs = 0;
  for (const t of targets) {
    const meta = (t as unknown as { meta: { suimonId: string; year: string; damId: string } }).meta;
    const damId = BigInt(meta.damId);
    const year = Number(meta.year);
    try {
      await startRunning('suimon', damId, year);
      const raw = await suimonAdapter.fetchRaw(t, ctx);
      if (!raw) {
        await complete('suimon', damId, year, 0);
        continue;
      }
      const parsed = await suimonAdapter.parse(raw, t);
      const key = rawSnapshotKey('suimon', t.targetId, ctx.runAt, 'csv');
      const uri = `s3://${process.env.S3_BUCKET ?? 'dam-raw'}/${key}`;
      await putSnapshot(key, raw.bytes, raw.contentType);
      const rawId = await recordRawSnapshot({
        sourceId: 'suimon',
        targetId: t.targetId,
        fetchedAt: ctx.runAt,
        storageUri: uri,
        httpStatus: raw.status,
        bytes: raw.bytes.byteLength,
        contentType: raw.contentType,
      });
      const inputs = parsed.map((p) => ({
        observedAt: p.observedAt,
        damId,
        sourceId: 'suimon',
        storageVolumeM3: p.storageVolumeM3 ?? null,
        storageRate: p.storageRate ?? null,
        inflowM3s: p.inflowM3s ?? null,
        outflowM3s: p.outflowM3s ?? null,
        waterLevelM: p.waterLevelM ?? null,
        rainfallMm: p.rainfallMm ?? null,
        rawSnapshotId: rawId,
        qualityFlag: 0,
      }));
      const written = await upsertObservations(inputs);
      await markParsed(rawId);
      await complete('suimon', damId, year, written);
      totalObs += written;
    } catch (e) {
      await fail('suimon', damId, year, (e as Error).message);
      helpers.logger.error(`suimon ${damId} ${year}: ${(e as Error).message}`);
    }
  }
  helpers.logger.info(`suimon backfill batch: obs=${totalObs}`);
};

export default task;
