const FLAG_LABEL: Record<number, string> = {
  1: '欠損補間',
  2: '異常値',
  4: '線形補間',
  8: 'ソース不一致',
  16: '手動レビュー',
};

export function QualityBadge({ flag }: { flag: number }) {
  if (!flag)
    return <span className="text-xs px-1.5 py-0.5 bg-emerald-50 text-emerald-700 rounded">OK</span>;
  const labels: string[] = [];
  for (const bit of [1, 2, 4, 8, 16]) if (flag & bit) labels.push(FLAG_LABEL[bit] ?? '');
  return (
    <span className="text-xs px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded">
      {labels.join(' ')}
    </span>
  );
}
