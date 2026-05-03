// Auth.js v5 (next-auth@5) — Google SSO only.
// Required env vars (set in Coolify, NOT in the repo):
//   AUTH_SECRET           random hex (e.g. `openssl rand -hex 32`)
//   AUTH_GOOGLE_ID        OAuth client ID from Google Cloud Console
//   AUTH_GOOGLE_SECRET    OAuth client secret
//   NEXTAUTH_URL          (auto-derived in prod from headers; set explicitly only for dev tunnels)
//
// Strategy: stateless JWT session. We don't persist user rows — `api_keys`
// already keys on email, which we trust as the stable identifier coming back
// from Google's id_token (verified by the provider).
import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    // Auth.js reads AUTH_GOOGLE_ID + AUTH_GOOGLE_SECRET from process.env
    // automatically when the provider is invoked with no explicit config.
    Google,
  ],
  pages: {
    // Land users on /account/sign-in instead of the default Auth.js page.
    signIn: '/account/sign-in',
  },
  callbacks: {
    async signIn({ profile }) {
      // Reject sign-in if Google didn't verify the email — keeps the
      // api_keys.email trust boundary tight.
      if (!profile?.email_verified) return false;
      return true;
    },
    async session({ session, token }) {
      if (token.sub && session.user) {
        // surface the Google `sub` for any future audit needs
        (session.user as typeof session.user & { sub?: string }).sub = token.sub;
      }
      return session;
    },
  },
});
