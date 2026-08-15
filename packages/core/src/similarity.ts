const KANJI_ORDINAL_DIGIT: Readonly<Record<string, string>> = {
  一: '1',
  二: '2',
  三: '3',
  四: '4',
  五: '5',
  六: '6',
  七: '7',
  八: '8',
  九: '9',
  十: '10',
};

export function normalizeJaName(input: string): string {
  let s = input.normalize('NFKC').trim();
  // small ヶ (U+30F6) and ヵ (U+30F5) are interchangeable with full ケ/カ in place names
  s = s.replace(/ヶ/g, 'ケ').replace(/ヵ/g, 'カ');
  // Fold 第N ordinals to arabic so sibling dams spelled 第二 / 第2 / 第２ share
  // a stem (NFKC already handled the fullwidth form). Scoped to the 第 marker
  // because bare kanji numerals are usually part of the name itself (五ケ山,
  // 二居). The lookahead leaves compound numerals such as 第十一 untouched
  // rather than mangling them into 第101.
  s = s.replace(
    /第([一二三四五六七八九十])(?![一二三四五六七八九十])/gu,
    (_m, d: string) => `第${KANJI_ORDINAL_DIGIT[d]}`,
  );
  // strip parenthesized readings
  s = s.replace(/[（(].*?[)）]/g, '');
  // strip "ダム" / "貯水池" suffix
  s = s.replace(/(?:ダム|貯水池)$/u, '');
  s = s.trim().toLowerCase();
  // strip trailing " dam" (latin) after lowercasing
  s = s.replace(/\s+dam$/u, '');
  return s.trim();
}

function trigrams(input: string): Set<string> {
  const padded = `  ${input}  `;
  const set = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) {
    set.add(padded.slice(i, i + 3));
  }
  return set;
}

export function trigramSimilarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = trigrams(a);
  const tb = trigrams(b);
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}
