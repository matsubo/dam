// packages/core/src/source_adapter.ts
export type Schedule = 'hourly' | 'daily' | 'on-demand';

export interface FetchTarget {
  /** Stable identifier within the source (e.g., kasenbosai dam id) */
  targetId: string;
  /** URL to fetch */
  url: string;
  /** Optional metadata that the parser will need (no I/O here) */
  meta?: Record<string, string>;
}

export interface RawBytes {
  bytes: Uint8Array;
  contentType: string;
  etag?: string;
  status: number;
}

export interface ParsedReading {
  damExternalId: { source: string; id: string };
  observedAt: Date;
  storageVolumeM3?: number | null;
  storageRate?: number | null;
  inflowM3s?: number | null;
  outflowM3s?: number | null;
  waterLevelM?: number | null;
  rainfallMm?: number | null;
}

export interface SourceAdapter {
  readonly id: string; // matches source_priorities.source_id
  readonly schedule: Schedule;
  fetchTargets(ctx: FetchContext): Promise<FetchTarget[]>;
  fetchRaw(target: FetchTarget, ctx: FetchContext): Promise<RawBytes | null>; // null = unchanged (304)
  parse(raw: RawBytes, target: FetchTarget): Promise<ParsedReading[]>;
}

export interface FetchContext {
  /** When the run started — adapters should use this for snapshot timestamps */
  runAt: Date;
}
