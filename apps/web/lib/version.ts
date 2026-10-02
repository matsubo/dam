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
// Lifecycle stage lives in ./stage.ts (alpha ≤ v0.2, beta from v0.3, GA ≥ v1.0.0).
//
// Within a stage: minor for additive endpoints, patch for fixes.
import manifest from '../../../package.json';

export const APP_VERSION: string = manifest.version;

/** Lifecycle stage label rendered in the header, footer, OpenAPI description and /roadmap. */
export { APP_STAGE, STAGE_JA } from './stage.ts';
