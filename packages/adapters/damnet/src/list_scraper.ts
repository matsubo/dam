import { prefNameToCode } from '@dam/core/prefectures';
import * as cheerio from 'cheerio';
import type { DamnetListItem } from './types.ts';

export { prefNameToCode } from '@dam/core/prefectures';

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
