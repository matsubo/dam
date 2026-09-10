'use client';

import { usePathname } from 'next/navigation';
import Script from 'next/script';
import { useEffect } from 'react';
import { isAdEligible } from '../lib/ad-eligibility.ts';

// Google AdSense. Two components, one gate.
//
//   <AdSenseAuto />  — loads the AdSense script. Mounted once in app/layout.tsx.
//                      With 自動広告 enabled in the console, Google places the
//                      ads itself; no slot id needed.
//   <AdSlot slot=… /> — one manual unit at a spot you choose. Needs a slot id.
//
// Both are gated the same way, and both render nothing unless:
//   1. NEXT_PUBLIC_ADSENSE_CLIENT is set — dev, CI and any deploy that hasn't
//      opted in stay completely ad-free, exactly like <GoogleAnalytics />; and
//   2. isAdEligible(pathname) is true — see ../lib/ad-eligibility.ts.
//
// Auto ads respect gate 2 because they only run where the AdSense script is
// present, and <AdSenseAuto /> injects the script on eligible routes only.
// The gate fails if the script reaches a page some other way, so:
//
// ⚠️ Do NOT add the AdSense tag to the GTM container (<Gtm /> is mounted
//    site-wide in app/layout.tsx) and do NOT hard-code the script into
//    layout.tsx. Either would put it on every page and let auto ads run there.
//
// One residual hole: on a client-side navigation the script stays loaded, so
// moving from an eligible page to an ineligible one can carry auto ads along.
// Use AdSense → 自動広告 → ページ除外 for anything that must never show them.

const ADSENSE_CLIENT = process.env.NEXT_PUBLIC_ADSENSE_CLIENT;
/** Default in-content unit id, so pages don't each hard-code one. */
const DEFAULT_SLOT = process.env.NEXT_PUBLIC_ADSENSE_SLOT_CONTENT;

type AdsByGoogleWindow = Window & { adsbygoogle?: unknown[] };

const SCRIPT_SRC = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT}`;

/**
 * Loads the AdSense script on ad-eligible routes only.
 *
 * Mount once, near the top of <body> in app/layout.tsx. With 自動広告 on,
 * this is the whole integration — Google chooses placements. Because the
 * script is absent everywhere else, auto ads stay confined to the routes
 * ad-eligibility.ts allows.
 */
export function AdSenseAuto() {
  const pathname = usePathname();
  if (!ADSENSE_CLIENT || !isAdEligible(pathname)) return null;
  return (
    <Script
      id="adsbygoogle-lib"
      src={SCRIPT_SRC}
      strategy="afterInteractive"
      crossOrigin="anonymous"
    />
  );
}

export interface AdSlotProps {
  /**
   * The ad unit's data-ad-slot id from the AdSense console. Defaults to
   * NEXT_PUBLIC_ADSENSE_SLOT_CONTENT; renders nothing when neither is set.
   */
  slot?: string;
  /** Optional wrapper classes for spacing within the page. */
  className?: string;
}

/**
 * One manual AdSense unit. Renders nothing unless both gates pass.
 *
 * Place it only inside a page whose route is listed in AD_ELIGIBLE_ROUTES —
 * the runtime check is a backstop, not a licence to drop it anywhere.
 */
export function AdSlot({ slot, className }: AdSlotProps) {
  const pathname = usePathname();
  const unit = slot ?? DEFAULT_SLOT ?? '';
  const enabled = Boolean(ADSENSE_CLIENT) && unit.length > 0 && isAdEligible(pathname);

  // Hooks run unconditionally; the render below is what short-circuits.
  useEffect(() => {
    if (!enabled) return;
    try {
      const w = window as AdsByGoogleWindow;
      w.adsbygoogle = w.adsbygoogle ?? [];
      w.adsbygoogle.push({});
    } catch (error) {
      // A failed push costs us one impression and nothing else — never let it
      // take the page down.
      console.error('AdSense push failed:', error);
    }
  }, [enabled]);

  if (!enabled) return null;

  return (
    <>
      <Script
        id="adsbygoogle-lib"
        src={SCRIPT_SRC}
        strategy="afterInteractive"
        crossOrigin="anonymous"
      />
      <ins
        // Remounting per route gives AdSense a fresh <ins>; pushing into one it
        // has already filled throws "All ins elements already have ads".
        key={pathname}
        className={`adsbygoogle block${className ? ` ${className}` : ''}`}
        style={{ display: 'block' }}
        data-ad-client={ADSENSE_CLIENT}
        data-ad-slot={unit}
        data-ad-format="auto"
        data-full-width-responsive="true"
      />
    </>
  );
}
