import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { auth, signIn } from '../../../auth.ts';
import { Breadcrumbs } from '../../../components/breadcrumbs.tsx';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'サインイン',
  robots: { index: false, follow: false },
};

export default async function SignIn({
  searchParams,
}: {
  searchParams?: Promise<{ callbackUrl?: string }>;
}) {
  const sp = (await searchParams) ?? {};
  const session = await auth();
  if (session?.user) redirect(sp.callbackUrl ?? '/account/keys');

  // Server Action: triggers the Google OAuth dance + redirects back to the
  // requested URL (defaults to /account/keys).
  async function signInGoogle(): Promise<void> {
    'use server';
    await signIn('google', { redirectTo: sp.callbackUrl ?? '/account/keys' });
  }

  return (
    <div className="max-w-xl mx-auto px-5 md:px-10 py-12">
      <Breadcrumbs items={[{ label: 'ホーム', href: '/' }, { label: 'サインイン' }]} />
      <h1 className="text-3xl font-semibold mb-3">サインイン</h1>
      <p className="text-on-surface-variant mb-8">
        API キーを発行・管理するには Google アカウントでサインインしてください。
        メールアドレスはキー単位の識別子・連絡先としてのみ利用します。
      </p>
      <form action={signInGoogle}>
        <button type="submit" className="btn-primary text-base">
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="#fff"
              d="M21.35 11.1H12v3.2h5.35c-.23 1.4-1.65 4.1-5.35 4.1-3.22 0-5.85-2.66-5.85-5.95s2.63-5.95 5.85-5.95c1.83 0 3.06.78 3.76 1.45l2.55-2.46C16.46 3.99 14.4 3 12 3 6.95 3 2.85 7.1 2.85 12.15S6.95 21.3 12 21.3c6.92 0 9.55-4.85 9.55-7.4 0-.5-.05-.9-.2-1.8z"
            />
          </svg>
          Google でサインイン
        </button>
      </form>
    </div>
  );
}
