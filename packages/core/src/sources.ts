// packages/core/src/sources.ts — one declaration per source (docs/adr/0001).
//
// Every per-source fact lives in SOURCES (./source_registry.ts): priority,
// description, status, the coverage-gate flags, the trusted rate basis, the
// schedule, the freshness override and the editorial details. Everything else
// is derived from it: the worker's crontab (./crontab.ts), each source's poll
// cadence, the freshness overrides, the /sources page text and the
// `source_priorities` rows (packages/db/src/sync_sources.ts, run by
// deploy/bootstrap.sh after migrations).

import type { SourceDeclaration, SourceStatus } from './source_declaration.ts';
import { SOURCES } from './source_registry.ts';

export type {
  SourceDeclaration,
  SourceDetails,
  SourceJob,
  SourceStatus,
} from './source_declaration.ts';
export { defineSource } from './source_declaration.ts';
export { SOURCES };

const BY_ID: ReadonlyMap<string, SourceDeclaration> = new Map(SOURCES.map((s) => [s.id, s]));

export function sourceById(id: string): SourceDeclaration | undefined {
  return BY_ID.get(id);
}

/** Badge / link text for a source id, falling back to the id itself. */
export function sourceLabel(id: string): string {
  return BY_ID.get(id)?.details.label ?? id;
}

/**
 * What the site says about a source, from its declaration alone: the part of
 * the source summary (@dam/db/repo/source_summary) that needs no database.
 * The /sources pages, /api/v1/sources and /md/sources all project it.
 */
export interface SourceFacts {
  readonly sourceId: string;
  readonly label: string;
  readonly description: string;
  /** Organization, system and page the data comes from. */
  readonly upstream: string;
  /** Which dams and which quantities. */
  readonly what: string;
  readonly cadence: string;
  /** The provider's terms as they apply to us; null = not checked yet (未確認). */
  readonly license: string | null;
  readonly status: SourceStatus;
  /** Higher wins when several sources hold the same dam and time. */
  readonly priority: number;
  readonly providesObservations: boolean;
  readonly trustedRateBasis: boolean;
}

export function sourceFacts(s: SourceDeclaration): SourceFacts {
  return {
    sourceId: s.id,
    label: s.details.label ?? s.id,
    description: s.description,
    upstream: s.details.upstream,
    what: s.details.what,
    cadence: s.details.cadence,
    license: s.details.license,
    status: s.status,
    priority: s.priority,
    providesObservations: s.providesObservations,
    trustedRateBasis: s.trustedRateBasis,
  };
}

/** Every declared source's facts, highest priority first, then by id. */
export function allSourceFacts(): SourceFacts[] {
  return SOURCES.map(sourceFacts).sort(
    (a, b) => b.priority - a.priority || a.sourceId.localeCompare(b.sourceId),
  );
}

/** Explicit staleness thresholds, keyed by source id. */
export const FRESHNESS_OVERRIDE_HOURS: Readonly<Record<string, number | null>> = Object.fromEntries(
  SOURCES.filter((s) => s.freshnessOverrideHours !== undefined).map((s) => [
    s.id,
    s.freshnessOverrideHours ?? null,
  ]),
);
