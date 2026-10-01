import type { Metadata } from 'next';
import Link from 'next/link';
import { RedocViewer } from '../../../components/redoc-viewer.tsx';

export const metadata: Metadata = {
  title: 'ダムデータ API ドキュメント',
  description:
    '全国2,700基以上のダムの貯水量・貯水率・流入量・放流量を JSON / CSV で取得できる無料 API のドキュメント。HAL+JSON 形式の応答と API キー認証、各エンドポイントの仕様と応答例を掲載。',
  alternates: { canonical: '/api/docs' },
};

// The heading and intro are server-rendered so crawlers and no-JS clients see
// what the page is; the Redoc reference below renders client-side only.
export default function ApiDocsPage() {
  return (
    <>
      <div className="max-w-7xl mx-auto px-5 md:px-10 pt-8">
        <h1 className="text-2xl font-semibold mb-3">ダムデータ API ドキュメント</h1>
        <p className="text-base text-on-surface-variant leading-relaxed max-w-3xl">
          全国のダムの諸元と貯水量・貯水率・流入量・放流量の履歴を HAL+JSON または CSV で返す無料の
          REST API です。利用には{' '}
          <Link href="/account/keys" className="text-primary hover:underline">
            API キー
          </Link>
          が必要で、仕様は{' '}
          <a href="/api/v1/openapi.json" className="text-primary hover:underline">
            OpenAPI
          </a>{' '}
          形式でも取得できます。
        </p>
      </div>
      <RedocViewer />
    </>
  );
}
