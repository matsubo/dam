// The permanent contributor credits rendered at /contribute#contributors.
//
// This list is a promise, not decoration: anyone who lands a contribution is
// added here and stays for as long as the site is up. Removing an entry needs
// the contributor's own request — never a cleanup pass.
//
// To add someone: append an entry, keep `since` as the ISO date their first
// contribution merged, and describe the work in their own words where possible.

export interface Contributor {
  /** Display name, as the person wants to be credited. */
  name: string;
  /** GitHub handle without the `@`. Optional — nobody is required to link one. */
  github?: string;
  /** Personal site / profile the person wants credited instead of, or besides, GitHub. */
  url?: string;
  /** ISO date (YYYY-MM-DD) the first contribution landed. */
  since: string;
  /** One line on what they built. */
  work: string;
}

export const CONTRIBUTORS: Contributor[] = [];

/** The person who runs the thing, for the "who is behind this" line. */
export const MAINTAINER = {
  name: 'matsubo',
  github: 'matsubo',
  sponsorsUrl: 'https://github.com/sponsors/matsubo',
} as const;

export const REPO_URL = 'https://github.com/matsubo/dam';

export const DISCORD_INVITE = 'https://discord.gg/UbWqspWbAk';
