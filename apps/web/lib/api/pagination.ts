// `nextCursor` is a bigint for id-keyed collections and an opaque string for
// collections paged on a composite key (see observation-cursor.ts).
export function pageLinks(
  self: string,
  nextCursor: bigint | string | null,
): { self: { href: string }; next?: { href: string } } {
  const out: { self: { href: string }; next?: { href: string } } = {
    self: { href: self },
  };
  if (nextCursor !== null) {
    const url = new URL(self, 'http://x');
    url.searchParams.set('cursor', nextCursor.toString());
    out.next = { href: `${url.pathname}${url.search}` };
  }
  return out;
}

export function rfc5988Link(nextCursor: bigint | string | null, self: string): string | null {
  if (nextCursor === null) return null;
  const url = new URL(self, 'http://x');
  url.searchParams.set('cursor', nextCursor.toString());
  return `<${url.pathname}${url.search}>; rel="next"`;
}
