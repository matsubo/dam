export function normalizeJaName(input: string): string {
  let s = input.normalize('NFKC').trim();
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
