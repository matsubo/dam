import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDamnetList } from './list_scraper.ts';

const FIXTURE = join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/damnet/list.html');

describe('parseDamnetList', () => {
  test('extracts list items with id, name, pref, detail url', async () => {
    const html = await readFile(FIXTURE, 'utf8');
    const items = parseDamnetList(html, 'http://damnet.or.jp');
    expect(items.length).toBe(2);
    expect(items[0]).toEqual({
      damnetId: '1234',
      name: '八ッ場ダム',
      prefCode: '10',
      detailUrl: 'http://damnet.or.jp/cgi-bin/binranA/All.cgi?db4=1234',
    });
    expect(items[1]?.prefCode).toBe('13');
  });
});
