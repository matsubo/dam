// Source-aware image credit. The two sources we actually use both require
// attribution; not showing it would be a license violation (CC-BY-SA for
// Wikipedia, Damnet's per-photo copyright). This helper produces the
// caption + link given a stored image URL.

export interface ImageCredit {
  /** Short text shown directly under or over the photo (e.g. "ダム便覧"). */
  text: string;
  /** Per-image source page (Commons file page for Wikipedia, dam page for
      Damnet) so the user can resolve author + licence themselves. */
  href: string;
  /** License hint shown in tooltip + a small line under the photo. */
  license: string;
}

/**
 * Extract the Commons file page URL from a Wikimedia thumbnail. Examples:
 *   https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Foo.jpg/800px-Foo.jpg
 *     → https://commons.wikimedia.org/wiki/File:Foo.jpg
 *   https://upload.wikimedia.org/wikipedia/commons/a/ab/Foo.jpg
 *     → https://commons.wikimedia.org/wiki/File:Foo.jpg
 *   https://upload.wikimedia.org/wikipedia/ja/thumb/a/ab/Foo.jpg/800px-Foo.jpg
 *     → https://ja.wikipedia.org/wiki/File:Foo.jpg  (per-language file)
 * Returns null when we can't decode the path safely.
 */
function commonsFileUrl(url: string): string | null {
  try {
    const u = new URL(url);
    // path layout: /wikipedia/<wiki>/[thumb/]<a>/<ab>/<Filename>[/<size>-<Filename>]
    const m = u.pathname.match(
      /^\/wikipedia\/([a-z]+)\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/]+?)(?:\/[^/]+)?$/,
    );
    if (!m) return null;
    const [, wiki, file] = m;
    const decodedFile = decodeURIComponent(file ?? '');
    if (!decodedFile) return null;
    // For commons-wiki files, the canonical file page lives on Commons. For
    // per-language wikis (e.g. /wikipedia/ja/...), the file is local to that
    // wiki and Commons may 404 — link to the language wiki instead.
    if (wiki === 'commons') {
      return `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(decodedFile)}`;
    }
    return `https://${wiki}.wikipedia.org/wiki/File:${encodeURIComponent(decodedFile)}`;
  } catch {
    return null;
  }
}

export function imageCredit(url: string | null | undefined): ImageCredit | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname.endsWith('damnet.or.jp')) {
      // Damnet photos are uploaded under wp-content/uploads/<yyyy>/<mm>/<DAMID>...jpg.
      // We can't link to the exact photo-detail page, but the dam landing
      // page on Damnet is recoverable from the file basename (NNNN prefix).
      const m = url.match(/\/(\d{4})[A-Z]{2}/);
      const damnetHref = m
        ? `https://dambinran.damnet.or.jp/dams/japan/${m[1]}/`
        : 'https://dambinran.damnet.or.jp/';
      return {
        text: '© ダム便覧',
        href: damnetHref,
        license: '一般財団法人日本ダム協会 / 写真の著作権は撮影者に帰属',
      };
    }
    if (u.hostname.endsWith('wikipedia.org') || u.hostname.endsWith('wikimedia.org')) {
      // Wikimedia thumbnails (upload.wikimedia.org/wikipedia/commons/thumb/...)
      // and per-language wikipedia thumbnails. We resolve the file page so
      // users can find the actual author + licence (CC-BY-SA, public-domain
      // and others mix on Commons).
      const filePage = commonsFileUrl(url) ?? 'https://commons.wikimedia.org/';
      return {
        text: 'Photo: Wikimedia',
        href: filePage,
        license: 'CC-BY-SA / 著作者表示は各ファイルページを参照',
      };
    }
  } catch {
    // Fall through to null
  }
  return null;
}
