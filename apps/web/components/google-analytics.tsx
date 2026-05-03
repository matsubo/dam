import Script from 'next/script';

// Google Analytics 4 via gtag.js — independent of GTM.
//
// Two-pronged analytics setup:
//   - GTM (NEXT_PUBLIC_GTM_ID) is the long-term home for marketing tags. Configure
//     GA4 as a tag inside the GTM container if you prefer single-source-of-truth.
//   - GA4 direct (NEXT_PUBLIC_GA4_ID) is a fallback for cases where GTM isn't yet
//     wired up to GA, or you want raw gtag without the GTM container.
//
// Both can co-exist; running both will cause double-counting in GA so pick one.
// Component renders nothing when NEXT_PUBLIC_GA4_ID is unset.

const GA4_ID = process.env.NEXT_PUBLIC_GA4_ID;

export function GoogleAnalytics() {
  if (!GA4_ID) return null;
  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${GA4_ID}`}
        strategy="afterInteractive"
      />
      <Script
        id="ga4-init"
        strategy="afterInteractive"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: gtag bootstrap snippet
        dangerouslySetInnerHTML={{
          __html: `window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${GA4_ID}', { send_page_view: true });`,
        }}
      />
    </>
  );
}
