import { sql } from '@dam/db/client';
import type { Metadata } from 'next';
import { Breadcrumbs } from '../../components/breadcrumbs.tsx';
import { FAQ } from '../../lib/faq.ts';

// Reads source_priorities, so it cannot be prerendered at build time (no DB).
export const dynamic = 'force-dynamic';
export const revalidate = 3600;
export const metadata: Metadata = {
  title: 'よくある質問',
  description:
    '貯水率は公式発表値か計算値か、複数の出典がある場合どれを表示するか、貯水率の分母、（元）/（再）の 2 件表示など、Dam Data Platform のデータの見方をまとめました。',
  alternates: { canonical: '/faq' },
};

interface TrustedSource {
  source_id: string;
  description: string | null;
}

async function trustedSources(): Promise<TrustedSource[]> {
  return sql<TrustedSource[]>`
    SELECT source_id, description FROM source_priorities
    WHERE active AND trusted_rate_basis
    ORDER BY priority DESC
  `;
}

export default async function FaqPage() {
  const trusted = await trustedSources();
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQ.map((f) => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: { '@type': 'Answer', text: f.answer.join('\n') },
    })),
  };
  return (
    <div className="max-w-3xl mx-auto px-5 md:px-10 py-8">
      <Breadcrumbs items={[{ label: 'ホーム', href: '/' }, { label: 'よくある質問' }]} />
      <h1 className="text-2xl font-semibold mb-6">よくある質問</h1>

      <nav className="mb-8 text-sm">
        <ul className="list-disc pl-5 space-y-1">
          {FAQ.map((f) => (
            <li key={f.id}>
              <a href={`#${f.id}`} className="text-primary hover:underline">
                {f.question}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {FAQ.map((f) => (
        <section key={f.id} id={f.id} className="mb-8 scroll-mt-20">
          <h2 className="text-lg font-semibold mb-2">{f.question}</h2>
          <div className="text-sm text-on-surface-variant leading-relaxed space-y-2">
            {f.answer.map((p) => (
              <p key={p}>{p}</p>
            ))}
            {f.id === 'rate-origin' && trusted.length > 0 ? (
              <div data-testid="trusted-sources">
                <p className="font-semibold text-on-surface">
                  公表値をそのまま使っている出典（{trusted.length} 件）
                </p>
                <ul className="list-disc pl-5">
                  {trusted.map((s) => (
                    <li key={s.source_id}>
                      <code className="text-xs">{s.source_id}</code>
                      {s.description ? ` — ${s.description}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {f.links?.length ? (
              <p className="text-xs">
                {f.links.map((l, i) => (
                  <span key={l.href}>
                    {i > 0 ? ' / ' : ''}
                    <a href={l.href} className="text-primary hover:underline">
                      {l.label}
                    </a>
                  </span>
                ))}
              </p>
            ) : null}
          </div>
        </section>
      ))}

      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: required to emit schema.org JSON-LD */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
    </div>
  );
}
