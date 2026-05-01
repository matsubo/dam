import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="text-center py-16">
      <h1 className="text-3xl font-semibold mb-2">ページが見つかりません</h1>
      <p className="text-muted mb-4">URLが正しいか確認してください。</p>
      <Link href="/">ホームへ戻る</Link>
    </div>
  );
}
