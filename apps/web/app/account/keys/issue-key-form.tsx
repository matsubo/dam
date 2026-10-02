'use client';

import { useActionState } from 'react';
import { type IssueState, issueKeyAction } from './actions.ts';

export function IssueKeyForm() {
  const [state, action, pending] = useActionState<IssueState, FormData>(issueKeyAction, {
    status: 'idle',
  });

  return (
    <>
      {state.status === 'issued' ? (
        <section className="mb-8 border-2 border-primary rounded-xl p-5 bg-primary/5">
          <h2 className="font-display font-bold text-on-surface mb-2">
            ✅ 新しい API キーを発行しました
          </h2>
          <p className="text-sm text-on-surface-variant mb-3">
            このキーは <strong>この画面でしか見られません</strong>
            。今すぐ安全な場所に保存してください。
          </p>
          <code className="block bg-[#0e141b] text-white font-code text-sm p-3 rounded-lg break-all select-all">
            {state.plaintext}
          </code>
          <p className="text-xs text-on-surface-variant mt-3">
            使用例:{' '}
            <code className="font-code">
              curl -H "Authorization: Bearer {state.plaintext}" https://dam.teraren.com/api/v1/dams
            </code>
          </p>
        </section>
      ) : null}

      <section className="card-surface mb-8">
        <h2 className="font-display font-semibold mb-3">新規発行</h2>
        <form action={action} className="flex flex-wrap gap-2 items-center text-sm">
          <input
            type="text"
            name="label"
            placeholder="ラベル(任意): 例「研究用」「個人ダッシュボード」"
            maxLength={80}
            className="flex-1 min-w-[260px] border border-outline-variant rounded-lg px-3 py-2"
          />
          <button type="submit" disabled={pending} className="btn-primary !py-2 !px-5 text-sm">
            発行
          </button>
        </form>
        {state.status === 'limit' ? (
          <p role="alert" className="text-sm text-red-700 mt-2">
            有効なキーは 1 アカウント {state.max}{' '}
            個までです。不要なキーを取り消してから発行してください。
          </p>
        ) : null}
        <p className="text-xs text-on-surface-variant mt-2">
          無料枠: 600 req/min、100,000 req/day。`Authorization: Bearer …` で送信 (旧仕様の
          `X-API-Key` ヘッダも互換のため引き続き受け付けます)。
        </p>
      </section>
    </>
  );
}
