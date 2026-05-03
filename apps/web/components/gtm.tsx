import Script from 'next/script';

// Google Tag Manager. Renders nothing when NEXT_PUBLIC_GTM_ID is unset, so
// dev/CI runs stay free of analytics scripts.
//
// Mount the <Gtm /> component once near the top of <body> in app/layout.tsx
// and the <GtmNoscript /> component immediately inside <body> for the
// noscript fallback. Both no-op when the ID isn't configured.

const GTM_ID = process.env.NEXT_PUBLIC_GTM_ID;

export function Gtm() {
  if (!GTM_ID) return null;
  return (
    <Script
      id="gtm-init"
      strategy="afterInteractive"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: GTM bootstrap snippet
      dangerouslySetInnerHTML={{
        __html: `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','${GTM_ID}');`,
      }}
    />
  );
}

export function GtmNoscript() {
  if (!GTM_ID) return null;
  return (
    <noscript>
      <iframe
        title="Google Tag Manager"
        src={`https://www.googletagmanager.com/ns.html?id=${GTM_ID}`}
        height="0"
        width="0"
        style={{ display: 'none', visibility: 'hidden' }}
      />
    </noscript>
  );
}
