import type { FetchContext, ParsedReading, SourceAdapter } from '@dam/core/source_adapter';
import { sql } from '@dam/db/client';
import { type ObservationInput, upsertObservations } from '@dam/db/repo/observations';
import { markParsed, markParseError, recordRawSnapshot } from '@dam/db/repo/raw_snapshots';
import { putSnapshot, rawSnapshotKey } from '@dam/storage/snapshot_store';
import { detectOutlier, isPhysicallyValid, QualityFlag } from './quality.ts';

export interface IngestResult {
  rawSnapshots: number;
  observationsWritten: number;
  errors: number;
}

async function damIdByExternalId(source: string, id: string): Promise<bigint | null> {
  const rows = await sql<{ id: bigint }[]>`
    SELECT id FROM dams WHERE external_ids ->> ${source} = ${id}
  `;
  return rows[0]?.id ?? null;
}

async function previousValue(damId: bigint, sourceId: string): Promise<number | null> {
  const rows = await sql<{ storage_volume_m3: string | null }[]>`
    SELECT storage_volume_m3 FROM observations
    WHERE dam_id = ${damId} AND source_id = ${sourceId}
    ORDER BY observed_at DESC LIMIT 1
  `;
  const v = rows[0]?.storage_volume_m3;
  return v == null ? null : Number(v);
}

function extensionFor(contentType: string): string {
  if (contentType.includes('json')) return 'json';
  if (contentType.includes('xml')) return 'xml';
  if (contentType.includes('html')) return 'html';
  return 'bin';
}

export async function runIngestForAdapter(
  adapter: SourceAdapter,
  ctx: FetchContext,
): Promise<IngestResult> {
  const targets = await adapter.fetchTargets(ctx);
  let rawSnapshots = 0;
  let observationsWritten = 0;
  let errors = 0;

  for (const target of targets) {
    try {
      const raw = await adapter.fetchRaw(target, ctx);
      if (!raw) continue; // unchanged (e.g. 304)

      // Store raw snapshot — non-fatal: if S3 is unavailable observations
      // still write with rawSnapshotId=null.
      let rawId: bigint | null = null;
      try {
        const ext = extensionFor(raw.contentType);
        const key = rawSnapshotKey(adapter.id, target.targetId, ctx.runAt, ext);
        const uri = `s3://${process.env.S3_BUCKET ?? 'dam-raw'}/${key}`;
        await putSnapshot(key, raw.bytes, raw.contentType);
        rawId = await recordRawSnapshot({
          sourceId: adapter.id,
          targetId: target.targetId,
          fetchedAt: ctx.runAt,
          storageUri: uri,
          httpStatus: raw.status,
          etag: raw.etag ?? null,
          bytes: raw.bytes.byteLength,
          contentType: raw.contentType,
        });
        rawSnapshots++;
      } catch (snapErr) {
        console.error(
          `ingest ${adapter.id} ${target.targetId}: snapshot storage skipped: ${(snapErr as Error).message}`,
        );
      }

      let parsed: ParsedReading[];
      try {
        parsed = await adapter.parse(raw, target);
      } catch (e) {
        if (rawId != null) await markParseError(rawId, (e as Error).message);
        errors++;
        continue;
      }

      const inputs: ObservationInput[] = [];
      for (const p of parsed) {
        const damId = await damIdByExternalId(p.damExternalId.source, p.damExternalId.id);
        if (damId === null) continue; // unknown dam: skip silently for now
        let flag = 0;
        if (!isPhysicallyValid(p)) flag |= QualityFlag.Outlier;
        const prev = await previousValue(damId, adapter.id);
        if (p.storageVolumeM3 != null && detectOutlier({ prev, current: p.storageVolumeM3 })) {
          flag |= QualityFlag.Outlier;
        }
        inputs.push({
          observedAt: p.observedAt,
          damId,
          sourceId: adapter.id,
          storageVolumeM3: p.storageVolumeM3 ?? null,
          storageRate: p.storageRate ?? null,
          inflowM3s: p.inflowM3s ?? null,
          outflowM3s: p.outflowM3s ?? null,
          waterLevelM: p.waterLevelM ?? null,
          rainfallMm: p.rainfallMm ?? null,
          rawSnapshotId: rawId,
          qualityFlag: flag,
        });
      }
      observationsWritten += await upsertObservations(inputs);
      if (rawId != null) await markParsed(rawId);
    } catch (e) {
      console.error(`ingest ${adapter.id} ${target.targetId}: ${(e as Error).message}`);
      errors++;
    }
  }

  return { rawSnapshots, observationsWritten, errors };
}
