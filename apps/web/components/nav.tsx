import Link from 'next/link';

export function Nav() {
  return (
    <header className="fixed top-0 w-full z-50 bg-white/85 backdrop-blur-md border-b border-outline-variant">
      <nav className="max-w-7xl mx-auto px-5 md:px-10 flex justify-between items-center h-16">
        <Link href="/" className="flex items-center gap-2.5 group no-underline">
          <span className="material-symbols-outlined text-primary text-2xl">water</span>
          <span className="font-display text-lg font-extrabold tracking-tight text-on-surface">
            Dam Data
          </span>
          <span className="hidden md:inline text-xs text-on-surface-variant font-semibold">
            · 日本のダム情報
          </span>
        </Link>
        <div className="hidden lg:flex items-center gap-8">
          <Link href="/dams" className="nav-link">
            ダム
          </Link>
          <Link href="/watersheds" className="nav-link">
            水系
          </Link>
          <Link href="/map" className="nav-link">
            地図
          </Link>
          <Link href="/stats" className="nav-link">
            統計
          </Link>
          <Link href="/sources" className="nav-link">
            データソース
          </Link>
          <Link href="/api/docs" className="nav-link">
            API
          </Link>
          <Link href="/account/keys" className="nav-link">
            アカウント
          </Link>
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
            <span className="material-symbols-outlined">search</span>
          </Link>
          <label htmlFor="nav-toggle" className="lg:hidden cursor-pointer p-2 rounded-lg hover:bg-surface-container">
            <span className="material-symbols-outlined">menu</span>
          </label>
          <input type="checkbox" id="nav-toggle" className="peer hidden" />
          <div className="hidden peer-checked:block lg:peer-checked:hidden absolute left-0 right-0 top-16 bg-white border-b border-outline-variant shadow-xl">
            <ul className="max-w-7xl mx-auto px-5 py-4 space-y-1">
              <li>
                <Link href="/dams" className="block px-3 py-2.5 rounded-lg font-medium hover:bg-surface-container-low">
                  ダム
                </Link>
              </li>
              <li>
                <Link href="/watersheds" className="block px-3 py-2.5 rounded-lg font-medium hover:bg-surface-container-low">
                  水系
                </Link>
              </li>
              <li>
                <Link href="/map" className="block px-3 py-2.5 rounded-lg font-medium hover:bg-surface-container-low">
                  地図
                </Link>
              </li>
              <li>
                <Link href="/stats" className="block px-3 py-2.5 rounded-lg font-medium hover:bg-surface-container-low">
                  統計
                </Link>
              </li>
              <li>
                <Link href="/sources" className="block px-3 py-2.5 rounded-lg font-medium hover:bg-surface-container-low">
                  データソース
                </Link>
              </li>
              <li>
                <Link href="/api/docs" className="block px-3 py-2.5 rounded-lg font-medium text-primary hover:bg-surface-container-low">
                  API仕様
                </Link>
              </li>
            </ul>
          </div>
        </div>
      </nav>
    </header>
  );
}
