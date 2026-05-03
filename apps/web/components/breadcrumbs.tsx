import Link from 'next/link';

interface Crumb {
  label: string;
  href?: string;
}

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.label,
      ...(c.href ? { item: `${base}${c.href}` } : {}),
    })),
  };
  return (
    <>
      <nav className="text-sm text-muted mb-4">
        <ol className="flex flex-wrap gap-2">
          {items.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: breadcrumb items are stable and ordered
            <li key={i} className="flex items-center gap-2">
              {i > 0 && <span aria-hidden>›</span>}
              {c.href ? <Link href={c.href}>{c.label}</Link> : <span>{c.label}</span>}
            </li>
          ))}
        </ol>
      </nav>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: required to emit schema.org JSON-LD */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
    </>
  );
}
