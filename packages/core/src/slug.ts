const KANA_TO_ROMAJI: Record<string, string> = {
  あ: 'a',
  い: 'i',
  う: 'u',
  え: 'e',
  お: 'o',
  か: 'ka',
  き: 'ki',
  く: 'ku',
  け: 'ke',
  こ: 'ko',
  さ: 'sa',
  し: 'shi',
  す: 'su',
  せ: 'se',
  そ: 'so',
  た: 'ta',
  ち: 'chi',
  つ: 'tsu',
  て: 'te',
  と: 'to',
  な: 'na',
  に: 'ni',
  ぬ: 'nu',
  ね: 'ne',
  の: 'no',
  は: 'ha',
  ひ: 'hi',
  ふ: 'fu',
  へ: 'he',
  ほ: 'ho',
  ま: 'ma',
  み: 'mi',
  む: 'mu',
  め: 'me',
  も: 'mo',
  や: 'ya',
  ゆ: 'yu',
  よ: 'yo',
  ら: 'ra',
  り: 'ri',
  る: 'ru',
  れ: 're',
  ろ: 'ro',
  わ: 'wa',
  を: 'wo',
  ん: 'n',
  が: 'ga',
  ぎ: 'gi',
  ぐ: 'gu',
  げ: 'ge',
  ご: 'go',
  ざ: 'za',
  じ: 'ji',
  ず: 'zu',
  ぜ: 'ze',
  ぞ: 'zo',
  だ: 'da',
  ぢ: 'ji',
  づ: 'zu',
  で: 'de',
  ど: 'do',
  ば: 'ba',
  び: 'bi',
  ぶ: 'bu',
  べ: 'be',
  ぼ: 'bo',
  ぱ: 'pa',
  ぴ: 'pi',
  ぷ: 'pu',
  ぺ: 'pe',
  ぽ: 'po',
};

const YOUON_TO_ROMAJI: Record<string, string> = {
  きゃ: 'kya',
  きゅ: 'kyu',
  きょ: 'kyo',
  しゃ: 'sha',
  しゅ: 'shu',
  しょ: 'sho',
  ちゃ: 'cha',
  ちゅ: 'chu',
  ちょ: 'cho',
  にゃ: 'nya',
  にゅ: 'nyu',
  にょ: 'nyo',
  ひゃ: 'hya',
  ひゅ: 'hyu',
  ひょ: 'hyo',
  みゃ: 'mya',
  みゅ: 'myu',
  みょ: 'myo',
  りゃ: 'rya',
  りゅ: 'ryu',
  りょ: 'ryo',
  ぎゃ: 'gya',
  ぎゅ: 'gyu',
  ぎょ: 'gyo',
  じゃ: 'ja',
  じゅ: 'ju',
  じょ: 'jo',
  びゃ: 'bya',
  びゅ: 'byu',
  びょ: 'byo',
  ぴゃ: 'pya',
  ぴゅ: 'pyu',
  ぴょ: 'pyo',
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

function romanizeKana(input: string): string {
  const hira = katakanaToHiragana(input);
  const chars = Array.from(hira);
  let out = '';
  let pendingSokuon = false;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] ?? '';
    // Sokuon: doubles the consonant of the next produced romaji syllable.
    if (ch === 'っ') {
      pendingSokuon = true;
      continue;
    }
    let r: string;
    const next = chars[i + 1] ?? '';
    const digraph = ch + next;
    if (next && YOUON_TO_ROMAJI[digraph] !== undefined) {
      r = YOUON_TO_ROMAJI[digraph] ?? '';
      i++;
    } else {
      const code = ch.codePointAt(0) ?? 0;
      if (isHiragana(code)) {
        r = KANA_TO_ROMAJI[ch] ?? '';
      } else {
        r = ch;
      }
    }
    if (pendingSokuon) {
      if (r.length > 0) {
        out += r[0] + r;
      }
      pendingSokuon = false;
    } else {
      out += r;
    }
  }
  return out;
}

export interface SlugOptions {
  kanaToRomaji?: boolean;
}

export function toSlug(input: string, options: SlugOptions = {}): string {
  const kanaToRomaji = options.kanaToRomaji ?? true;
  // Use NFKC so halfwidth katakana (ﾔﾝﾊﾞ) folds to fullwidth (ヤンバ) and
  // other compatibility forms collapse, while dakuten stay precomposed
  // (ば remains a single code point so the romaji table matches). NFKD
  // would decompose ば into は + U+3099 and break the lookup.
  let base = input.normalize('NFKC').toLowerCase();
  if (kanaToRomaji) {
    base = romanizeKana(base);
    // Hepburn: n becomes m before b, m, p (e.g. やんば → yanba → yamba).
    base = base.replace(/n([bmp])/g, 'm$1');
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
