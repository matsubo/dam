'use client';

import { usePathname } from 'next/navigation';
import Script from 'next/script';
import { useEffect } from 'react';
import { isAdEligible } from '../lib/ad-eligibility.ts';

// Google AdSense, gated twice over.
//
//   1. NEXT_PUBLIC_ADSENSE_CLIENT unset  → renders nothing at all.
//      Dev, CI and any deploy that hasn't opted in stay completely ad-free,
//      exactly like <GoogleAnalytics />.
//   2. Route not on the allowlist        → renders nothing.
//      See ../lib/ad-eligibility.ts: 国土数値情報 W01 is 商用利用不可 and feeds
//      the dam master, so most of this site may not carry ads.
//
// ⚠️ AUTO ADS MUST STAY OFF IN THE ADSENSE CONSOLE.
// "Auto ads" / 自動広告 inject units into every page from Google's side,
// ignoring this component entirely — which would silently defeat gate 2 and put
// ads on 国土数値情報-derived pages. Use manual ad units (this component) only.

const ADSENSE_CLIENT = process.env.NEXT_PUBLIC_ADSENSE_CLIENT;
/** Default in-content unit id, so pages don't each hard-code one. */
const DEFAULT_SLOT = process.env.NEXT_PUBLIC_ADSENSE_SLOT_CONTENT;

type AdsByGoogleWindow = Window & { adsbygoogle?: unknown[] };

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
        src={`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT}`}
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
