// Source-aware image credit. The two sources we actually use both require
// attribution; not showing it would be a license violation (CC-BY-SA for
// Wikipedia, Damnet's per-photo copyright). This helper produces the
// caption + link given a stored image URL.

export interface ImageCredit {
  /** Short text shown directly under or over the photo (e.g. "ダム便覧"). */
  text: string;
  /** Per-image source page, never the dam page. */
  href: string;
  /** License hint shown in tooltip. */
  license: string;
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
        license: '一般財団法人日本ダム協会 / 撮影者に帰属',
      };
    }
    if (u.hostname.endsWith('wikipedia.org') || u.hostname.endsWith('wikimedia.org')) {
      // Wikimedia thumbnails (e.g. upload.wikimedia.org/wikipedia/commons/thumb/...)
      // and ja.wikipedia.org pageimages thumbnails both originate from Commons.
      // We surface the Wikimedia Commons file page so users can find the
      // licence + author.
      return {
        text: 'Photo: Wikipedia',
        href: 'https://commons.wikimedia.org/',
        license: 'CC-BY-SA (各ファイルの作者に従う)',
      };
    }
  } catch {
    // Fall through to null
  }
  return null;
}
