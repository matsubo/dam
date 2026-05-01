import Link from 'next/link';

export function Pagination({
  basePath,
  prevCursor,
  nextCursor,
}: { basePath: string; prevCursor?: string | null; nextCursor?: string | null }) {
  return (
    <div className="flex justify-between mt-6">
      <div>{prevCursor ? <Link href={`${basePath}?cursor=${prevCursor}`}>« 前へ</Link> : null}</div>
      <div>{nextCursor ? <Link href={`${basePath}?cursor=${nextCursor}`}>次へ »</Link> : null}</div>
    </div>
  );
}
