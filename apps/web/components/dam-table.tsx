import { PREFECTURES } from '@dam/core/prefectures';
import Link from 'next/link';
import { fmtCapacityMcm } from '../lib/format.ts';

const PREF_NAME = new Map(PREFECTURES.map((p) => [p.code, p.name]));

export interface DamRowItem {
  slug: string;
  name: string;
  prefCode: string;
  manager: string | null;
  totalCapacityM3: string | null;
  watershedSlug: string | null;
  watershedName: string | null;
  imageUrl?: string | null;
}

export function DamTable({ rows }: { rows: DamRowItem[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>ダム名</th>
          <th>都道府県</th>
          <th>水系</th>
          <th>管理者</th>
          <th className="text-right">総貯水容量</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.slug}>
            <td>
              <Link href={`/dams/${r.slug}`}>{r.name}</Link>
            </td>
            <td>{PREF_NAME.get(r.prefCode) ?? r.prefCode}</td>
            <td>
              {r.watershedSlug ? (
                <Link href={`/watersheds/${r.watershedSlug}`}>{r.watershedName}</Link>
              ) : (
                '—'
              )}
            </td>
            <td>{r.manager ?? '—'}</td>
            <td className="text-right tabular-nums">{fmtCapacityMcm(r.totalCapacityM3)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
