import Link from 'next/link';

export function Nav() {
  return (
    <header className="border-b border-gray-200">
      <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between">
        <Link href="/" className="text-lg font-semibold text-ink">
          Dam Data
        </Link>
        <nav className="flex gap-6 text-sm">
          <Link href="/dams">ダム</Link>
          <Link href="/watersheds">水系</Link>
          <Link href="/map">地図</Link>
          <Link href="/sources">データソース</Link>
          <Link href="/api/docs">API</Link>
        </nav>
      </div>
    </header>
  );
}
