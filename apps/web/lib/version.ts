// The app version lives in exactly one place: the `version` field of the root
// package.json. Bump it with `just version-bump <patch|minor|major|x.y.z>`,
// which rewrites the manifest, commits, and creates the matching `vX.Y.Z` tag
// for `gh release`. Never write a version literal anywhere else.
//
// Consumed (server components / route handlers only — the default JSON import
// would otherwise ship the whole manifest to the browser) by:
//   - apps/web/app/layout.tsx                    — footer version label
//   - apps/web/app/api/v1/openapi.json/route.ts  — OpenAPI `info.version`
//   - apps/web/app/roadmap/page.tsx              — current-stage badge
//
// Lifecycle (see /roadmap):
//   0.x.y  — alpha (current): bootstrap + scheduled ingest stable
//   ≥0.next — beta:           data accuracy hardened
//   ≥1.0.0 — GA:              third-party SLA, latency budget, infra HA
//
// Within a stage: minor for additive endpoints, patch for fixes.
import manifest from '../../../package.json';

export const APP_VERSION: string = manifest.version;

/** Lifecycle stage label rendered in the footer + OpenAPI description + /roadmap. */
export const APP_STAGE: 'alpha' | 'beta' | 'ga' = 'alpha';
