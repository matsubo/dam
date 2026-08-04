'use client';

import { Droplets, Menu, Search, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { EntityIcon, type EntityKind } from './entity-icon.tsx';

const ITEMS: {
  href: string;
  label: string;
  emphasised?: boolean;
  entity?: EntityKind;
}[] = [
  { href: '/dams', label: 'ダム', entity: 'dam' },
  { href: '/watersheds', label: '水系', entity: 'watershed' },
  { href: '/map', label: '地図' },
  { href: '/stats', label: '統計' },
  { href: '/sources', label: 'データソース' },
  { href: '/api/docs', label: 'API', emphasised: true },
  { href: '/account/keys', label: 'アカウント' },
];

export function Nav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close the menu when the route changes — covers both clicks on items inside
  // the drawer and any other navigation triggered while it's open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is a re-run trigger, not read in the body
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Lock body scroll while the drawer is open so the page underneath doesn't
  // jiggle on iOS.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.body.style.overflow = open ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  return (
    <header className="fixed top-0 w-full z-50 bg-white/85 backdrop-blur-md border-b border-outline-variant">
      <nav className="max-w-7xl mx-auto px-5 md:px-10 flex justify-between items-center h-16">
        <Link href="/" className="flex items-center gap-2.5 group no-underline">
          <Droplets className="text-primary" size={24} aria-hidden="true" />
          <span className="font-display text-lg font-extrabold tracking-tight text-on-surface">
            Dam Data
          </span>
          <span className="hidden md:inline text-xs text-on-surface-variant font-semibold">
            · 日本のダム情報
          </span>
        </Link>
        <div className="hidden lg:flex items-center gap-8">
          {ITEMS.map((it) => (
            <Link
              key={it.href}
              href={it.href}
              className="nav-link inline-flex items-center gap-1.5"
            >
              {it.entity ? <EntityIcon kind={it.entity} size={14} className="shrink-0" /> : null}
              {it.label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <form action="/search" method="get" className="hidden md:flex items-center">
            <input
              type="search"
              name="q"
              placeholder="ダム・水系を検索"
              aria-label="検索"
              className="border border-outline-variant rounded-full px-4 py-1.5 text-sm w-48 focus:w-64 transition-all bg-surface-container-low focus:bg-white"
            />
          </form>
          <Link
            href="/search"
            aria-label="検索"
            className="md:hidden p-2 rounded-lg hover:bg-surface-container"
          >
            <Search size={22} aria-hidden="true" />
          </Link>
          <button
            type="button"
            aria-label={open ? 'メニューを閉じる' : 'メニューを開く'}
            aria-expanded={open}
            aria-controls="primary-mobile-nav"
            onClick={() => setOpen((v) => !v)}
            className="lg:hidden p-2 rounded-lg hover:bg-surface-container"
          >
            {open ? <X size={22} aria-hidden="true" /> : <Menu size={22} aria-hidden="true" />}
          </button>
        </div>
      </nav>

      {/* Mobile drawer. Rendered after <nav> so clicks outside the panel can
          dismiss it via the overlay. Hidden on lg+ regardless of `open`. */}
      {open ? (
        <div className="lg:hidden">
          <button
            type="button"
            aria-label="メニューを閉じる"
            onClick={() => setOpen(false)}
            className="fixed inset-0 top-16 bg-black/20 z-40 cursor-default"
          />
          <div
            id="primary-mobile-nav"
            className="absolute left-0 right-0 top-16 bg-white border-b border-outline-variant shadow-xl z-50"
          >
            <ul className="max-w-7xl mx-auto px-5 py-4 space-y-1">
              {ITEMS.map((it) => (
                <li key={it.href}>
                  <Link
                    href={it.href}
                    onClick={() => setOpen(false)}
                    className={`flex items-center gap-2 px-3 py-2.5 rounded-lg font-medium hover:bg-surface-container-low ${
                      it.emphasised ? 'text-primary' : ''
                    }`}
                  >
                    {it.entity ? (
                      <EntityIcon kind={it.entity} size={16} className="shrink-0" />
                    ) : null}
                    {it.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </header>
  );
}
