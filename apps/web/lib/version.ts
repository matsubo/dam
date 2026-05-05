// Single source of truth for the publicly-visible app version.
// Consumed by:
//   - apps/web/app/layout.tsx        — footer version label
//   - apps/web/app/api/v1/openapi.json/route.ts — OpenAPI `info.version`
//   - apps/web/app/roadmap/page.tsx  — current-stage badge
//
// Lifecycle (see /roadmap):
//   0.x.y  — alpha (current): bootstrap + scheduled ingest stable
//   ≥0.next — beta:           data accuracy hardened
//   ≥1.0.0 — GA:              third-party SLA, latency budget, infra HA
//
// Within a stage: minor for additive endpoints, patch for fixes.
export const APP_VERSION = '0.0.1';

/** Lifecycle stage label rendered in the footer + OpenAPI description + /roadmap. */
export const APP_STAGE: 'alpha' | 'beta' | 'ga' = 'alpha';
