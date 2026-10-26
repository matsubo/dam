// packages/core/src/sources.ts — one declaration per source (docs/adr/0001).
//
// Every per-source fact lives in SOURCES (./source_registry.ts): priority,
// description, status, the coverage-gate flags, the trusted rate basis, the
// schedule, the freshness override and the editorial details. Everything else
// is derived from it: the worker's crontab (./crontab.ts), each source's poll
// cadence, the freshness overrides, the /sources page text and the
// `source_priorities` rows (packages/db/src/sync_sources.ts, run by
// deploy/bootstrap.sh after migrations).

import type { SourceDeclaration } from './source_declaration.ts';
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

/** Explicit staleness thresholds, keyed by source id. */
export const FRESHNESS_OVERRIDE_HOURS: Readonly<Record<string, number | null>> = Object.fromEntries(
  SOURCES.filter((s) => s.freshnessOverrideHours !== undefined).map((s) => [
    s.id,
    s.freshnessOverrideHours ?? null,
  ]),
);
