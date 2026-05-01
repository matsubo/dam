const KANA_TO_ROMAJI: Record<string, string> = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', を: 'wo', ん: 'n',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
};

const KATAKANA_OFFSET = 0x60;
function katakanaToHiragana(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x30a1 && code <= 0x30f6) {
      out += String.fromCodePoint(code - KATAKANA_OFFSET);
    } else {
      out += ch;
    }
  }
  return out;
}

function isHiragana(code: number): boolean {
  return code >= 0x3040 && code <= 0x309f;
}

function isKatakana(code: number): boolean {
  return code >= 0x30a0 && code <= 0x30ff;
}

function romanizeKana(input: string): string {
  const hira = katakanaToHiragana(input);
  let out = '';
  for (const ch of hira) {
    const code = ch.codePointAt(0) ?? 0;
    if (isHiragana(code)) {
      out += KANA_TO_ROMAJI[ch] ?? '';
    } else {
      out += ch;
    }
  }
  return out;
}

export interface SlugOptions {
  kanaToRomaji?: boolean;
}

export function toSlug(input: string, options: SlugOptions = {}): string {
  const kanaToRomaji = options.kanaToRomaji ?? true;
  // Use NFC to keep composed kana (e.g. ば) as a single code point so the
  // romaji table matches; NFKD would decompose ば into は + U+3099.
  let base = input.normalize('NFC').toLowerCase();
  if (kanaToRomaji) {
    base = romanizeKana(base);
  } else {
    // strip kana entirely
    base = base.replace(/[぀-ゟ゠-ヿ]/g, '');
  }
  // Strip apostrophes/quotes outright so "O'Hara" → "ohara", not "o-hara".
  const stripped = base.replace(/['’`"]/g, '');
  const cleaned = stripped.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned;
}

export function suffixedSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
