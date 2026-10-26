// Fixture → universe entries for 香川県「降雨及び貯水率の状況」の主要ため池貯水率
// and the 宝山湖 block of the かがわの水 page, no database: binding and writing
// belong to the ingest run.
//
// Runs against the real 令和8年9月25日 PDF and the かがわの水 page captured on
// 2026-09-27 (tests/fixtures/kagawa_tameike), so the unpdf extraction is
// exercised too.

import { describe, expect, test } from 'bun:test';
import type { Entry, Reading } from '../ingest/types.ts';
import {
  type Fetcher,
  findLatestPdfUrl,
  hozankoEntry,
  parseHozankoHtml,
  parseKagawaTameikeText,
  pondEntries,
  readPonds,
} from './ingest_kagawa_tameike.ts';
import { pdfToText } from './ingest_oita_nourin.ts';

const DIR = new URL('../../../../tests/fixtures/kagawa_tameike/', import.meta.url).pathname;
const text = await pdfToText(
  new Uint8Array(await Bun.file(`${DIR}chosui20260925.pdf`).arrayBuffer()),
);
const indexHtml = await Bun.file(`${DIR}kfvn_20260927.html`).text();
const ponds = pondEntries(text);

function readingOf(e: Entry | undefined): Reading {
  const r = e?.reading;
  if (!r || typeof r === 'function') throw new Error('no static reading');
  return r;
}

function rate(e: Entry | undefined): number | null | undefined {
  const r = readingOf(e);
  return r.state === 'values' ? r.observations[0]?.storageRate : undefined;
}

describe('pondEntries — the real 令和8年9月25日 PDF', () => {
  test('dates the ponds by their own survey day, not the report day', () => {
    // The PDF is issued 9月25日 but the ため池 column is 「9月16日現在」.
    expect(parseKagawaTameikeText(text).surveyDate?.toISOString()).toBe('2026-09-15T15:00:00.000Z');
    const r = readingOf(ponds[0]);
    if (r.state !== 'values') throw new Error(r.state);
    expect(r.observations[0]?.observedAt.toISOString()).toBe('2026-09-15T15:00:00.000Z');
  });

  test('lists every pond of the ため池 column and none of the dam column', () => {
    expect(ponds).toHaveLength(26);
    expect(ponds.some((p) => p.name.endsWith('ダム'))).toBe(false);
    expect(ponds[0]?.name).toBe('宮池');
    expect(rate(ponds[0])).toBe(0.75);
    for (const p of ponds) {
      expect(p.pref).toBe('37');
      expect(readingOf(p).state).toBe('values');
    }
  });

  test('reads the whole-percent rate as a fraction', () => {
    const byName = (name: string) => rate(ponds.find((p) => p.name === name));
    expect(byName('満濃池')).toBe(0.79);
    expect(byName('公渕池')).toBe(0.62);
    expect(byName('三五郎池')).toBe(1);
  });

  test('binds a pond only by its exact name, 渕 folded to the master 淵', () => {
    // Pond names are generic (新池, 城池, 大谷池 exist all over the
    // prefecture), so a prefix must never bind; the PDF's 公渕池 is the
    // master's 公淵池.
    expect(ponds.find((p) => p.name === '公渕池')?.bind).toEqual({
      name: '公淵池',
      exact: true,
    });
    expect(ponds.find((p) => p.name === '満濃池')?.bind).toEqual({ name: '満濃池', exact: true });
  });

  test('a pond printed without a figure is still listed: 「－」 empty, 0 % unreadable', () => {
    const t =
      '令和8年9月25日\n平年値 68\n宮池 － さぬき市\n石神池 0 〃\n奈良須池 100 高松市\nため池貯水率 (%)\n9月16日現在';
    const p = pondEntries(t);
    expect(p.map((e) => e.name)).toEqual(['宮池', '石神池', '奈良須池']);
    expect(p.map((e) => readingOf(e).state)).toEqual(['empty', 'unreadable', 'values']);
    expect(rate(p[2])).toBe(1);
  });
});

describe('year of the pond survey', () => {
  test('a December survey in a January report belongs to the previous year', () => {
    const t =
      '令和9年1月5日\n千足ダム 99.8 93 6.8 東かがわ市\n宮池 75 さぬき市\nため池貯水率 (%)\n12月16日現在1 月 5 日 0 時 現 在';
    expect(parseKagawaTameikeText(t).surveyDate?.toISOString()).toBe('2026-12-15T15:00:00.000Z');
  });
});

describe('findLatestPdfUrl', () => {
  test('finds the daily chosui PDF on the かがわの水 page', () => {
    expect(findLatestPdfUrl(indexHtml)).toBe(
      'https://www.pref.kagawa.lg.jp/documents/5847/chosui20260925.pdf',
    );
  });

  test('takes the newest date when several are linked', () => {
    const html =
      '<a href="/documents/5847/chosui20260901.pdf">a</a><a href="/documents/5847/chosui20260925.pdf">b</a><a href="/documents/5847/chosui20260916.pdf">c</a>';
    expect(findLatestPdfUrl(html)).toBe(
      'https://www.pref.kagawa.lg.jp/documents/5847/chosui20260925.pdf',
    );
  });
});

describe('parseHozankoHtml — 宝山湖 on the かがわの水 page', () => {
  test('reads the 宝山湖 rate, stamped at the stated hour JST', () => {
    // Re-captured 2026-09-28: byte-identical to this fixture. The page's
    // earlier blocks (早明浦 13.9%, 県内15ダム 92.2%, ため池 83%) must not leak in.
    expect(parseHozankoHtml(indexHtml)).toEqual({
      observedAt: new Date('2026-09-25T00:00:00.000Z'), // 9時 JST
      storageRate: 0.375,
    });
  });

  const block = (heading: string, rate: string) =>
    `<h2>早明浦ダム2026年9月25日（0時現在）</h2><table><tr><td>13.9%</td></tr></table>` +
    `<h2>${heading}</h2><table><tr><th>貯水量（100％）</th><th>現在貯水率</th></tr>` +
    `<tr><td><p>3百万立方メートル</p></td><td><p>${rate}<br /><img alt="w1_35.gif" /></p></td></tr></table>` +
    `<ul><li><a href="http://www.water.go.jp/yoshino/kagawa/">宝山湖情報（外部サイトへリンク）</a></li></ul>`;

  test('a heading without an hour is stamped at JST midnight', () => {
    expect(parseHozankoHtml(block('宝山湖2026年1月5日現在', '100%'))).toEqual({
      observedAt: new Date('2026-01-04T15:00:00.000Z'),
      storageRate: 1,
    });
  });

  test('a missing or zero figure carries no rate', () => {
    const heading = '宝山湖2026年9月25日（9時現在）';
    const at = new Date('2026-09-25T00:00:00.000Z');
    expect(parseHozankoHtml(block(heading, '－'))).toEqual({ observedAt: at, storageRate: null });
    expect(parseHozankoHtml(block(heading, '0.0%'))).toEqual({ observedAt: at, storageRate: null });
  });

  test('a page without the 宝山湖 block yields nothing, not the link text', () => {
    const html = block('県内15ダム2026年9月25日（0時現在）', '92.2%');
    expect(parseHozankoHtml(html)).toBeNull();
  });
});

describe('hozankoEntry', () => {
  test('is pinned to 香川用水調整池 by NDI 2170, not bound by name', () => {
    const e = hozankoEntry(indexHtml);
    expect(e).toMatchObject({ key: '宝山湖', name: '宝山湖', pref: '37' });
    expect(e.bind).toEqual({ ndi: '2170' });
    expect(rate(e)).toBe(0.375);
  });

  test('a page without the block still lists 宝山湖, unreadable', () => {
    expect(readingOf(hozankoEntry('<p>準備中</p>')).state).toBe('unreadable');
  });
});

describe('readPonds — a broken PDF must not cost 宝山湖 its write', () => {
  const html = '<a href="/documents/5847/chosui20260925.pdf">b</a>';

  test('a fetch that times out is logged and lists no pond', async () => {
    const timeout: Fetcher = async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    };
    const logs: string[] = [];
    expect(await readPonds(html, timeout, (s) => logs.push(s))).toEqual([]);
    expect(logs.join('\n')).toContain('timed out');
  });

  test('bytes that are not a PDF are logged and list no pond', async () => {
    const maintenance: Fetcher = async () => new Response('<html>メンテナンス中</html>');
    const logs: string[] = [];
    expect(await readPonds(html, maintenance, (s) => logs.push(s))).toEqual([]);
    expect(logs.join('\n')).toContain('PDF unreadable');
  });
});
