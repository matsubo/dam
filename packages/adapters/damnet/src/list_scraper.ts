import * as cheerio from 'cheerio';
import type { DamnetListItem } from './types.ts';

const PREF_NAME_TO_CODE: Record<string, string> = {
  北海道: '01', 青森県: '02', 岩手県: '03', 宮城県: '04', 秋田県: '05',
  山形県: '06', 福島県: '07', 茨城県: '08', 栃木県: '09', 群馬県: '10',
  埼玉県: '11', 千葉県: '12', 東京都: '13', 神奈川県: '14', 新潟県: '15',
  富山県: '16', 石川県: '17', 福井県: '18', 山梨県: '19', 長野県: '20',
  岐阜県: '21', 静岡県: '22', 愛知県: '23', 三重県: '24', 滋賀県: '25',
  京都府: '26', 大阪府: '27', 兵庫県: '28', 奈良県: '29', 和歌山県: '30',
  鳥取県: '31', 島根県: '32', 岡山県: '33', 広島県: '34', 山口県: '35',
  徳島県: '36', 香川県: '37', 愛媛県: '38', 高知県: '39', 福岡県: '40',
  佐賀県: '41', 長崎県: '42', 熊本県: '43', 大分県: '44', 宮崎県: '45',
  鹿児島県: '46', 沖縄県: '47',
};

export function prefNameToCode(name: string): string {
  const code = PREF_NAME_TO_CODE[name];
  if (!code) throw new Error(`Unknown prefecture name: ${name}`);
  return code;
}

export function parseDamnetList(html: string, baseUrl: string): DamnetListItem[] {
  const $ = cheerio.load(html);
  const items: DamnetListItem[] = [];
  $('table.dam-list tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 2) return;
    const prefName = $(cells[0]).text().trim();
    const a = $(cells[1]).find('a').first();
    const href = a.attr('href');
    const name = a.text().trim();
    if (!href || !name || !prefName) return;
    const m = href.match(/db4=(\d+)/);
    if (!m) return;
    items.push({
      damnetId: m[1] ?? '',
      name,
      prefCode: prefNameToCode(prefName),
      detailUrl: new URL(href, baseUrl).toString(),
    });
  });
  return items;
}
