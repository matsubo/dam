import { sql } from '@dam/db/client';
import { listDams } from '@dam/db/repo/dams';
import type { Metadata } from 'next';
import Link from 'next/link';
import { DamCard } from '../components/dam-card.tsx';

export const revalidate = 900;
export const metadata: Metadata = {
  title: { absolute: 'Dam Data Platform — 日本のダム貯水量' },
  description: '日本全国のダム貯水量データと推移。1時間ごとの最新値と長期トレンド。',
};

async function counts() {
  const rows = await sql<{ dams: bigint; watersheds: bigint; obs_today: bigint }[]>`
    SELECT
      (SELECT COUNT(*) FROM dams)::BIGINT AS dams,
      (SELECT COUNT(*) FROM watersheds)::BIGINT AS watersheds,
      (SELECT COUNT(*) FROM observations WHERE observed_at > NOW() - INTERVAL '24 hours')::BIGINT AS obs_today
  `;
  const row = rows[0];
  if (!row) throw new Error('counts query returned no row');
  return row;
}

export default async function Home() {
  const [c, latest] = await Promise.all([counts(), listDams({ pageSize: 6 })]);
  return (
    <>
      <section className="mb-10">
        <h1 className="text-4xl font-semibold mb-2">日本のダム貯水量データ</h1>
        <p className="text-muted text-lg">
          日本全国のダムを網羅し、1時間ごとに更新。災害予測・水不足予測のためのデータソース。
        </p>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-10">
        <Stat label="ダム" value={c.dams.toString()} />
        <Stat label="水系" value={c.watersheds.toString()} />
        <Stat label="直近24時間の観測" value={c.obs_today.toString()} />
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-semibold mb-4">代表的なダム</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {latest.items.map((d) => (
            <DamCard key={d.slug} d={d} />
          ))}
        </div>
        <p className="mt-4">
          <Link href="/dams">すべてのダムを見る →</Link>
        </p>
      </section>

      <section className="mb-10">
        <Link href="/map" className="block border border-gray-200 rounded p-6 hover:bg-gray-50">
          <h2 className="text-xl font-semibold">日本のダム地図 →</h2>
          <p className="text-muted">全国のダムを地図で確認。</p>
        </Link>
      </section>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-gray-200 rounded p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
