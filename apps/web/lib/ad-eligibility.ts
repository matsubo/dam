// Which routes may carry advertising.
//
// Deny-by-default: a route carries ads only by matching a rule below. A new
// page is ad-free until someone adds it deliberately.
//
// ## Why this file exists
//
// 国土数値情報 W01 / W05 / W07 are licensed 「非商用」 (旧国土情報利用約款準拠版),
// and W01 — the origin of the dam master — is 商用利用不可 outright (see the
// `ndi` entry in ./source-details.ts). Advertising is 営利目的, so this module
// originally excluded every page built on that data.
//
// **That is no longer what it does.** On 2026-09-10 the site owner decided to
// run ads on the dam 貯水率 pages to measure what they earn, accepting the
// licence exposure. Those pages render W01-derived values (location, height,
// total capacity, completed year — apps/web/app/dams/[slug]/page.tsx). The
// decision is recorded here so the code does not read as if the constraint
// were still being honoured.
//
// What the deny-by-default shape still buys us: the set of advertised pages is
// explicit, testable and small, so widening it is always a deliberate edit
// rather than a side effect. Pages that were never part of that decision —
// watershed and prefecture pages, /map, /stats, /search, /coverage, /sources,
// /contribute, the home page — stay out.
//
// ⚠️ Two ways to bypass everything here, both of which must stay off:
//   - AdSense「自動広告」(Auto ads) injects units from Google's side.
//   - Adding an AdSense tag to the GTM container (<Gtm /> is mounted in
//     app/layout.tsx) would inject them independently of this module.

/**
 * Static routes cleared to carry advertising, matched exactly.
 *
 * Hand-written prose that reads no dam or watershed row — the pages that were
 * licence-safe before the 2026-09-10 decision, kept because they still are.
 */
export const AD_ELIGIBLE_ROUTES = ['/glossary', '/roadmap'] as const;

/**
 * Dynamic routes cleared to carry advertising.
 *
 * `/dams/<slug>` only — the per-dam 貯水率 pages the owner asked for. One
 * segment, so the `/dams` list itself and anything deeper stay out.
 */
const AD_ELIGIBLE_PATTERNS: readonly RegExp[] = [/^\/dams\/[^/]+$/];

const ELIGIBLE: ReadonlySet<string> = new Set(AD_ELIGIBLE_ROUTES);

/**
 * Drop one trailing slash so `/glossary/` and `/glossary` agree. `/` is left
 * alone — it is never eligible anyway.
 */
function normalisePath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

/** True only for a route cleared above. Unknown route → false. */
export function isAdEligible(pathname: string): boolean {
  const path = normalisePath(pathname);
  if (ELIGIBLE.has(path)) return true;
  return AD_ELIGIBLE_PATTERNS.some((re) => re.test(path));
}
