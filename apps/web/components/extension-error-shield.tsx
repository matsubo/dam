'use client';

import { useEffect } from 'react';

// Some browser wallet extensions (MetaMask, Phantom, Coinbase Wallet, Brave
// Wallet, etc.) inject `window.ethereum` and then assign to its properties.
// In strict-mode pages this throws `undefined is not an object (evaluating
// 'window.ethereum.selectedAddress = undefined')`, which Next dev's overlay
// then surfaces as a runtime error.
//
// The error originates entirely outside our code — there is nothing we can
// fix at the source. We swallow the global event so the dev overlay doesn't
// flag it. Production builds don't render the overlay anyway, so this is
// effectively a dev-only papercut shield.
const EXTENSION_ERROR_PATTERNS = [
  /window\.ethereum/,
  /window\.solana/,
  /window\.tron/,
  /chrome-extension:\/\//,
  /moz-extension:\/\//,
  /safari-extension:\/\//,
];

function isExtensionNoise(message: unknown, source: unknown): boolean {
  const m = String(message ?? '');
  const s = String(source ?? '');
  return EXTENSION_ERROR_PATTERNS.some((re) => re.test(m) || re.test(s));
}

export function ExtensionErrorShield(): null {
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      if (isExtensionNoise(e.message, e.filename)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason as { message?: unknown; stack?: unknown } | undefined;
      if (isExtensionNoise(r?.message, r?.stack)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener('error', onError, true);
    window.addEventListener('unhandledrejection', onRejection, true);
    return () => {
      window.removeEventListener('error', onError, true);
      window.removeEventListener('unhandledrejection', onRejection, true);
    };
  }, []);
  return null;
}
