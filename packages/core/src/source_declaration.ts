// The shape of one source declaration. The declarations themselves are in
// ./source_registry.ts; ./sources.ts is what callers import.

/** Editorial text shown on /sources and /sources/[id]. */
export interface SourceDetails {
  /** Short provider / system name for badges and link text; the id when absent. */
  label?: string;
  /** Organization, system and page the data comes from. */
  upstream: string;
  /**
   * The provider's terms as they apply to us, or `null` when they have not
   * been checked yet (shown as 未確認).
   */
  license: string | null;
  /** How often the provider updates and when we read it. */
  cadence: string;
  /** Which dams and which quantities. */
  what: string;
}

/** A scheduled job that reads the source, other than its ingest task. */
export interface SourceJob {
  /** graphile-worker cron fields, UTC. */
  cron: string;
  task: string;
  /** JSON5 payload, as graphile-worker's crontab takes it. */
  payload?: string;
}

/**
 * `active`: read on schedule. `retired`: no longer read; its history stays
 * attributed. `historical`: backfill only, never scanned on a schedule.
 */
export type SourceStatus = 'active' | 'retired' | 'historical';

export interface SourceDeclaration {
  /** Stable source id: observations.source_id, source_priorities.source_id. */
  readonly id: string;
  /** Higher wins when several sources hold the same dam and time. */
  readonly priority: number;
  readonly description: string;
  readonly status: SourceStatus;
  /** False for master-attribute sources (dam locations, specs, images). */
  readonly providesObservations: boolean;
  /** False when the provider's published list cannot be enumerated. */
  readonly universeEnumerable: boolean;
  /** Its 貯水率 is the manager's own figure against the pool it is managed by. */
  readonly trustedRateBasis: boolean;
  /** The scheduled ingest task and its cron (UTC), if it has one. */
  readonly ingest: { readonly task: string; readonly cron: string } | null;
  readonly jobs: readonly SourceJob[];
  /**
   * Staleness threshold in hours, replacing the derived one; `null` means
   * silent by design and never stale; absent means derive it.
   */
  readonly freshnessOverrideHours?: number | null;
  readonly details: SourceDetails;
}

export interface SourceInput {
  id: string;
  priority: number;
  description: string;
  status?: SourceStatus;
  providesObservations?: boolean;
  universeEnumerable?: boolean;
  trustedRateBasis?: boolean;
  /** Cron (UTC) of `ingest:<id>`. */
  ingestCron?: string;
  /** Ingest task name when it is not `ingest:<id>`. */
  ingestTask?: string;
  jobs?: SourceJob[];
  freshnessOverrideHours?: number | null;
  details: SourceDetails;
}

export function defineSource(input: SourceInput): SourceDeclaration {
  return {
    id: input.id,
    priority: input.priority,
    description: input.description,
    status: input.status ?? 'active',
    providesObservations: input.providesObservations ?? true,
    universeEnumerable: input.universeEnumerable ?? true,
    trustedRateBasis: input.trustedRateBasis ?? false,
    ingest: input.ingestCron
      ? { task: input.ingestTask ?? `ingest:${input.id}`, cron: input.ingestCron }
      : null,
    jobs: input.jobs ?? [],
    ...(input.freshnessOverrideHours !== undefined
      ? { freshnessOverrideHours: input.freshnessOverrideHours }
      : {}),
    details: input.details,
  };
}
