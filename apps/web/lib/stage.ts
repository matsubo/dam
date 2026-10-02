// Lifecycle stage of the service (see /roadmap). Kept apart from version.ts so
// client components (the header badge) can import it without pulling the root
// package.json into the browser bundle.
//
//   alpha  — bootstrap + scheduled ingest stable (≤ v0.2)
//   beta   — data accuracy hardened (public β, from v0.3)
//   ga     — third-party SLA, latency budget, infra HA (≥ v1.0.0)
export type AppStage = 'alpha' | 'beta' | 'ga';

export const APP_STAGE: AppStage = 'beta';

/** Japanese name used in prose: 「本サービスは現在ベータ段階です」. */
export const STAGE_JA: Record<AppStage, string> = {
  alpha: 'アルファ',
  beta: 'ベータ',
  ga: '正式リリース',
};

/** One-glyph badge for the header; GA shows none. */
export const STAGE_GLYPH: Record<AppStage, string | null> = {
  alpha: 'α',
  beta: 'β',
  ga: null,
};
