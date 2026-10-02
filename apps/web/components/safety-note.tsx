import { TriangleAlert } from 'lucide-react';

// Shown next to observed values. People land on these pages during heavy rain;
// the 利用規約 (/legal/terms) already says the values are not for disaster
// decisions, but nobody reads the terms from a dam page.
export function SafetyNote() {
  return (
    <aside
      role="note"
      aria-label="防災判断についての注意"
      className="mb-4 flex gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-on-surface-variant"
    >
      <TriangleAlert className="text-amber-700 shrink-0 mt-0.5" size={16} aria-hidden="true" />
      <p>
        表示値は各提供元の公開値を自動で取得したもので、遅延・欠測・誤りを含むことがあります。
        避難などの判断には、自治体・気象庁・
        <a
          href="https://www.river.go.jp/"
          className="text-primary hover:underline"
          rel="noopener noreferrer"
          target="_blank"
        >
          川の防災情報
        </a>
        などの一次情報を必ず確認してください。
      </p>
    </aside>
  );
}
