// Which routes may carry advertising.
//
// This is a LICENCE boundary, not a layout preference.
//
// 国土数値情報 W01 / W05 / W07 are licensed 「非商用」 (旧国土情報利用約款準拠版),
// and W01 — the origin of the dam master — is 商用利用不可 outright. See the `ndi`
// entry in ./source-details.ts. Advertising is 営利目的, so any page that renders a
// W01/W05/W07-derived value must not carry ads.
//
// We cannot decide that per-field at runtime: `dams` and `watersheds` (see
// packages/db/src/schema/) merge every upstream into one row and keep NO
// per-field provenance, and `dams.location`, `watersheds.kind` and
// `watersheds.boundary` are all NOT NULL. So a dam or watershed row is
// NLNI-derived by construction.
//
// Therefore the list below is an ALLOWLIST and matching is exact: a route earns
// ads only by being named here. A new page is ad-free until someone confirms it
// renders no NLNI-derived field and adds it deliberately.

/**
 * Routes cleared to carry advertising. Static, hand-written content that reads
 * no dam or watershed row.
 *
 * Deliberately excluded, and why:
 *   /, /dams*, /watersheds*, /map, /stats, /search, /coverage, /prefectures/*
 *     → render W01/W05/W07-derived values
 *   /sources, /sources/[id]  → summarise dam counts per upstream
 *   /legal/*                 → our own terms; ads there serve nobody
 *   /account/*, /admin/*     → private / operator surfaces
 *   /api/docs                → machine-facing reference
 *
 * A route audit raised /coverage and /sources as borderline: they only GROUP BY
 * pref_code and bucket total_capacity_m3 / height_m / completed_year, never
 * printing a raw per-dam NLNI value. They stay excluded anyway. 非商用 restricts
 * 利用 of the data, not the display of raw values — an aggregate is a derived
 * work, and aggregating does not launder the licence. /sources is also the page
 * that publishes the 非商用 terms themselves, so advertising on it would be odd.
 */
export const AD_ELIGIBLE_ROUTES = ['/glossary', '/roadmap'] as const;

const ELIGIBLE: ReadonlySet<string> = new Set(AD_ELIGIBLE_ROUTES);

/**
 * Drop one trailing slash so `/glossary/` and `/glossary` agree. `/` is left
 * alone — it is never eligible anyway.
 */
function normalisePath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

/** True only for a route explicitly cleared above. Unknown route → false. */
export function isAdEligible(pathname: string): boolean {
  return ELIGIBLE.has(normalisePath(pathname));
}
