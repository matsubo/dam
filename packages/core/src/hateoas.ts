export interface Link {
  href: string;
  templated?: boolean;
  type?: string;
  title?: string;
}

export type LinksInput = Record<string, Link | null | undefined>;
export type Links = Record<string, Link>;

export function buildLinks(input: LinksInput): Links {
  const out: Links = {};
  for (const [rel, link] of Object.entries(input)) {
    if (!link) continue;
    out[rel] = link;
  }
  return out;
}
