'use server';

import { issueSelfServiceKey, MAX_ACTIVE_KEYS_PER_EMAIL } from '@dam/db/repo/api_keys';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { auth } from '../../../auth.ts';

export type IssueState =
  | { status: 'idle' }
  | { status: 'issued'; plaintext: string }
  | { status: 'limit'; max: number };

/**
 * Returns the plaintext to the form that asked for it. It used to travel in a
 * redirect URL (`?issued=<key>`), which put every new key into analytics page
 * views, access logs and browser history.
 */
export async function issueKeyAction(_prev: IssueState, formData: FormData): Promise<IssueState> {
  const email = (await auth())?.user?.email;
  if (!email) redirect('/account/sign-in?callbackUrl=/account/keys');
  const label = String(formData.get('label') ?? '').slice(0, 80) || undefined;
  const issued = await issueSelfServiceKey(email, label);
  if (!issued) return { status: 'limit', max: MAX_ACTIVE_KEYS_PER_EMAIL };
  revalidatePath('/account/keys');
  return { status: 'issued', plaintext: issued.plaintext };
}
