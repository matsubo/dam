import {
  deleteAccountByEmail,
  issueKey,
  listKeysByEmail,
  revokeForEmail,
} from '@dam/db/repo/api_keys';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { auth, signOut } from '../../../auth.ts';
import { Breadcrumbs } from '../../../components/breadcrumbs.tsx';
import { fmtDateOnly } from '../../../lib/format.ts';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'API キー管理',
  robots: { index: false, follow: false },
};

interface SP {
  searchParams?: Promise<{ issued?: string; prefix?: string; delete_error?: string }>;
}

export default async function KeysPage({ searchParams }: SP) {
  const session = await auth();
  if (!session?.user?.email) {
    redirect('/account/sign-in?callbackUrl=/account/keys');
  }
  const email = session.user.email;
  const sp = (await searchParams) ?? {};
  const keys = await listKeysByEmail(email);

  // Server Actions
  async function issue(formData: FormData): Promise<void> {
    'use server';
    const me = (await auth())?.user?.email;
    if (!me) redirect('/account/sign-in');
    const label = String(formData.get('label') ?? '').slice(0, 80) || null;
    const r = await issueKey({ email: me, label: label ?? undefined });
    // Surface the plaintext via URL once — it's never stored cleartext, so
    // this redirect is the single chance to copy it.
    redirect(`/account/keys?issued=${encodeURIComponent(r.plaintext)}&prefix=${r.prefix}`);
  }
  async function revoke(formData: FormData): Promise<void> {
    'use server';
    const me = (await auth())?.user?.email;
    if (!me) redirect('/account/sign-in');
    const id = BigInt(String(formData.get('id') ?? '0'));
    if (id) await revokeForEmail(id, me);
    redirect('/account/keys');
  }
  async function doSignOut(): Promise<void> {
    'use server';
    await signOut({ redirectTo: '/' });
  }
  async function deleteAccount(formData: FormData): Promise<void> {
    'use server';
    const me = (await auth())?.user?.email;
    if (!me) redirect('/account/sign-in');
    // Require typed confirmation matching the email so a stray click on the
    // 退会 button can't nuke a user's keys + usage history.
    const confirm = String(formData.get('confirm') ?? '').trim();
    if (confirm !== me) {
      redirect('/account/keys?delete_error=mismatch');
    }
    await deleteAccountByEmail(me);
    await signOut({ redirectTo: '/?account=deleted' });
  }

  return (
    <div className="max-w-4xl mx-auto px-5 md:px-10 py-8">
      <Breadcrumbs
        items={[
          { label: 'ホーム', href: '/' },
          { label: 'アカウント', href: '/account/keys' },
          { label: 'API キー' },
        ]}
      />
      <header className="flex items-baseline justify-between mb-6 flex-wrap gap-2">
        <h1 className="text-3xl font-semibold">API キー</h1>
        <div className="flex items-center gap-3 text-sm text-on-surface-variant">
          <span>{email}</span>
          <form action={doSignOut}>
            <button type="submit" className="btn-outline !py-1 !px-3 text-xs">
              サインアウト
            </button>
          </form>
        </div>
      </header>

      {sp.issued ? (
        <section className="mb-8 border-2 border-primary rounded-xl p-5 bg-primary/5">
          <h2 className="font-display font-bold text-on-surface mb-2">
            ✅ 新しい API キーを発行しました
          </h2>
          <p className="text-sm text-on-surface-variant mb-3">
            このキーは <strong>この画面でしか見られません</strong>。今すぐ安全な場所に保存してください。
          </p>
          <code className="block bg-[#0e141b] text-white font-code text-sm p-3 rounded-lg break-all select-all">
            {sp.issued}
          </code>
          <p className="text-xs text-on-surface-variant mt-3">
            使用例:{' '}
            <code className="font-code">
              curl -H "Authorization: Bearer {sp.issued}"
              https://dam.teraren.com/api/v1/dams
            </code>
          </p>
        </section>
      ) : null}

      <section className="card-surface mb-8">
        <h2 className="font-display font-semibold mb-3">新規発行</h2>
        <form action={issue} className="flex flex-wrap gap-2 items-center text-sm">
          <input
            type="text"
            name="label"
            placeholder="ラベル(任意): 例「研究用」「個人ダッシュボード」"
            maxLength={80}
            className="flex-1 min-w-[260px] border border-outline-variant rounded-lg px-3 py-2"
          />
          <button type="submit" className="btn-primary !py-2 !px-5 text-sm">
            発行
          </button>
        </form>
        <p className="text-xs text-on-surface-variant mt-2">
          無料枠: 600 req/min、100,000 req/day。`Authorization: Bearer …` で送信
          (旧仕様の `X-API-Key` ヘッダも互換のため引き続き受け付けます)。
        </p>
      </section>

      <h2 className="font-display font-semibold mb-3">発行済み</h2>
      {keys.length === 0 ? (
        <p className="text-on-surface-variant text-sm">まだキーはありません。</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>プレフィックス</th>
              <th>ラベル</th>
              <th>枠</th>
              <th>発行日</th>
              <th>最終使用</th>
              <th>状態</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id.toString()}>
                <td className="font-code text-xs">{k.prefix}_•••</td>
                <td className="text-sm">{k.label ?? '—'}</td>
                <td className="text-xs tabular-nums">
                  {k.ratePerMin}/min · {k.ratePerDay}/day
                </td>
                <td className="text-xs text-on-surface-variant">{fmtDateOnly(k.createdAt)}</td>
                <td className="text-xs text-on-surface-variant">
                  {k.lastUsedAt ? fmtDateOnly(k.lastUsedAt) : '—'}
                </td>
                <td className="text-xs">
                  {k.revokedAt ? (
                    <span className="text-on-surface-variant">取消済</span>
                  ) : k.active ? (
                    <span className="text-primary font-semibold">有効</span>
                  ) : (
                    <span className="text-on-surface-variant">無効</span>
                  )}
                </td>
                <td>
                  {!k.revokedAt && k.active ? (
                    <form action={revoke}>
                      <input type="hidden" name="id" value={k.id.toString()} />
                      <button
                        type="submit"
                        className="text-xs text-red-700 hover:underline"
                        // biome-ignore lint/a11y/useButtonType: form submit
                      >
                        取消
                      </button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <section className="mt-12 border border-red-300 rounded-xl p-5 bg-red-50/40">
        <h2 className="font-display font-semibold text-red-800 mb-2">退会</h2>
        <p className="text-sm text-on-surface-variant mb-1">
          退会すると、このメールアドレス（<strong>{email}</strong>）に紐づく
          すべての API キーと利用履歴が <strong>完全に削除</strong> されます。
          公開ページの閲覧はサインアウト状態でも引き続き可能です。
        </p>
        <p className="text-xs text-on-surface-variant mb-3">
          この操作は取り消せません。同じ Google アカウントで再ログインすれば
          新しいキーは発行できますが、過去のキー / 利用履歴は復元できません。
        </p>
        {sp.delete_error === 'mismatch' ? (
          <p className="text-sm text-red-700 mb-3">
            確認文字列が一致しませんでした。再度お試しください。
          </p>
        ) : null}
        <form action={deleteAccount} className="flex flex-wrap gap-2 items-center">
          <label htmlFor="confirm-email" className="text-xs text-on-surface-variant">
            確認のため、ご自身のメールアドレスを入力してください:
          </label>
          <input
            id="confirm-email"
            type="email"
            name="confirm"
            required
            placeholder={email}
            className="flex-1 min-w-[260px] border border-red-300 rounded-lg px-3 py-2 text-sm"
          />
          <button
            type="submit"
            className="bg-red-700 hover:bg-red-800 text-white text-sm font-semibold py-2 px-5 rounded-lg"
          >
            退会する
          </button>
        </form>
      </section>
    </div>
  );
}
