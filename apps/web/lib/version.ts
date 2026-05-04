// Single source of truth for the publicly-visible app version.
// Consumed by:
//   - apps/web/app/layout.tsx        — footer version label
//   - apps/web/app/api/v1/openapi.json/route.ts — OpenAPI `info.version`
//
// Bump together with API surface changes. Major (1.x.0 → 2.0.0) for
// breaking API changes, minor for additive endpoints, patch for fixes.
export const APP_VERSION = '1.0.0';
