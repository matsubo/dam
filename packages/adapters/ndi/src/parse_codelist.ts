/**
 * 国土数値情報 codelist 「水系域コード種別」
 * (https://nlftp.mlit.go.jp/ksj/gml/codelist/WaterSystemCodeCd.html):
 * an HTML table of `<td>{6-digit code}</td><td>{水系名}</td>` rows.
 */

const ROW = /<td>\s*(\d{6})\s*<\/td>\s*<td>([^<]*)<\/td>/g;

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

export function parseWaterSystemCodelist(html: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(ROW)) {
    const code = m[1];
    const name = decodeEntities(m[2] ?? '').trim();
    if (code && name) out.set(code, name);
  }
  if (out.size === 0) throw new Error('codelist: no <td>code</td><td>name</td> rows found');
  return out;
}
