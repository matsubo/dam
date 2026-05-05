import { PREFECTURES } from '@dam/core/prefectures';
import Link from 'next/link';
import { fmtCapacityMcm } from '../lib/format.ts';
import { EntityIcon } from './entity-icon.tsx';

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
              <span className="inline-flex items-center gap-1.5">
                <EntityIcon kind="dam" size={14} className="text-primary shrink-0" />
                <Link href={`/dams/${r.slug}`}>{r.name}</Link>
              </span>
            </td>
            <td>{PREF_NAME.get(r.prefCode) ?? r.prefCode}</td>
            <td>
              {r.watershedSlug ? (
                <span className="inline-flex items-center gap-1.5">
                  <EntityIcon kind="watershed" size={14} className="shrink-0" />
                  <Link href={`/watersheds/${r.watershedSlug}`}>{r.watershedName}</Link>
                </span>
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
