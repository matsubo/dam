// Auth.js v5 catch-all route — handles /api/auth/signin, /signout, /callback,
// /session, /providers, /csrf, etc.
import { handlers } from '../../../../auth.ts';

export const { GET, POST } = handlers;
