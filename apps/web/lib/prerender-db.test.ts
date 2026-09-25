import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// `next build` prerenders every page without a dynamic segment, and the build
// has no database: a page that queries one must opt out, or the deploy fails
// (/faq did, 2026-09-26). Pages under [param] routes render on demand anyway.
const APP = join(import.meta.dir, '..', 'app');

function pages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name.startsWith('[') ? [] : pages(p);
    return e.name === 'page.tsx' ? [p] : [];
  });
}

describe('static pages that read the database', () => {
  test("declare dynamic = 'force-dynamic'", () => {
    const offenders = pages(APP)
      .filter((p) => {
        const src = readFileSync(p, 'utf8');
        return src.includes("from '@dam/db") && !src.includes("dynamic = 'force-dynamic'");
      })
      .map((p) => relative(APP, p));
    expect(offenders).toEqual([]);
  });
});
