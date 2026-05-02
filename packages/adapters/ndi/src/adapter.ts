// packages/adapters/ndi/src/adapter.ts
//
// Formal SourceAdapter wrapper around the NDI / NLNI W01 master importer.
// NDI is master data (no per-hour observations), so `parse()` returns an
// empty array. The wrapper exists so the worker pipeline can list every
// source uniformly. The actual master import is invoked separately via
// the existing CLI / `master_refresh_*` worker tasks.
import { readFile } from 'node:fs/promises';
import type {
  FetchContext,
  FetchTarget,
  ParsedReading,
  RawBytes,
  SourceAdapter,
} from '@dam/core/source_adapter';

const W01_LOCAL = process.env.NDI_W01_LOCAL ?? 'data/nlni/w01.geojson';

export const ndiAdapter: SourceAdapter = {
  id: 'ndi',
  schedule: 'on-demand',
  async fetchTargets(_ctx: FetchContext): Promise<FetchTarget[]> {
    return [{ targetId: 'W01', url: `file://${W01_LOCAL}` }];
  },
  async fetchRaw(target, _ctx): Promise<RawBytes | null> {
    const path = target.url.replace(/^file:\/\//, '');
    const bytes = new Uint8Array(await readFile(path));
    return { bytes, contentType: 'application/geo+json', status: 200 };
  },
  async parse(_raw, _target): Promise<ParsedReading[]> {
    // NDI rows are master data, not observations. Return empty so
    // the pipeline doesn't write to observations; the master importer
    // is invoked separately.
    return [];
  },
};
