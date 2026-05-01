'use client';
import Link from 'next/link';
import { useEffect } from 'react';

export default function ErrorPage({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="text-center py-16">
      <h1 className="text-3xl font-semibold mb-2">エラーが発生しました</h1>
      <p className="text-muted mb-4">{error.message}</p>
      <Link href="/">ホームへ戻る</Link>
    </div>
  );
}
