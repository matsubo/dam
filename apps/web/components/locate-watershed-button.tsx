'use client';

import { MapPin } from 'lucide-react';
import { useState } from 'react';

type LocateState = 'idle' | 'locating' | 'denied' | 'unavailable';

/**
 * 「現在地から水系を見る」— asks for browser geolocation and jumps to
 * /watersheds/locate, which resolves the containing (or nearest) watershed
 * server-side and redirects to its page.
 */
export function LocateWatershedButton({ className = '' }: { className?: string }) {
  const [state, setState] = useState<LocateState>('idle');

  const locate = () => {
    if (!('geolocation' in navigator)) {
      setState('unavailable');
      return;
    }
    setState('locating');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        window.location.assign(
          `/watersheds/locate?lat=${latitude.toFixed(5)}&lng=${longitude.toFixed(5)}`,
        );
      },
      (err) => {
        setState(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable');
      },
      { timeout: 10_000, maximumAge: 300_000 },
    );
  };

  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        onClick={locate}
        disabled={state === 'locating'}
        className={`btn-outline text-base inline-flex items-center gap-2 ${className}`}
      >
        <MapPin size={18} aria-hidden="true" />
        {state === 'locating' ? '現在地を取得中…' : '現在地から水系を見る'}
      </button>
      {state === 'denied' ? (
        <span className="text-xs text-on-surface-variant">
          位置情報が許可されませんでした。ブラウザの設定をご確認ください。
        </span>
      ) : null}
      {state === 'unavailable' ? (
        <span className="text-xs text-on-surface-variant">現在地を取得できませんでした。</span>
      ) : null}
    </span>
  );
}
