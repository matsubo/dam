// Parser tests for 香川県「降雨及び貯水率の状況」の主要ため池貯水率 and the
// 宝山湖 block of the かがわの水 page.
//
// Runs against the real 令和8年9月25日 PDF and the かがわの水 page captured on
// 2026-09-27 (tests/fixtures/kagawa_tameike), so the unpdf extraction is
// exercised too.

import { afterEach, describe, expect, test } from 'bun:test';
import type { BindableMaster } from '@dam/core/dam_binding';
import {
  chooseHozanko,
  chooseMaster,
  findLatestPdfUrl,
  parseHozankoHtml,
  parseKagawaTameikeText,
  readPonds,
} from './ingest_kagawa_tameike.ts';
import { pdfToText } from './ingest_oita_nourin.ts';

const DIR = new URL('../../../../tests/fixtures/kagawa_tameike/', import.meta.url).pathname;
const text = await pdfToText(
  new Uint8Array(await Bun.file(`${DIR}chosui20260925.pdf`).arrayBuffer()),
);
const parsed = parseKagawaTameikeText(text);

describe('parseKagawaTameikeText — the real 令和8年9月25日 PDF', () => {
  test('dates the ponds by their own survey day, not the report day', () => {
    // The PDF is issued 9月25日 but the ため池 column is 「9月16日現在」.
    expect(parsed.surveyDate?.toISOString()).toBe('2026-09-15T15:00:00.000Z');
  });

  test('reads every pond of the ため池 column and none of the dam column', () => {
    expect(parsed.rows).toHaveLength(26);
    expect(parsed.rows.some((r) => r.name.endsWith('ダム'))).toBe(false);
    expect(parsed.rows[0]).toEqual({ name: '宮池', storageRate: 0.75 });
    expect(parsed.published).toEqual(parsed.rows.map((r) => r.name));
  });

  test('reads the whole-percent rate as a fraction', () => {
    const rate = (name: string) => parsed.rows.find((r) => r.name === name)?.storageRate;
    expect(rate('満濃池')).toBe(0.79);
    expect(rate('公渕池')).toBe(0.62);
    expect(rate('三五郎池')).toBe(1);
  });

  test('a pond printed without a figure is published but not stored', () => {
    const t =
      '令和8年9月25日\n平年値 68\n宮池 － さぬき市\n石神池 0 〃\n奈良須池 100 高松市\nため池貯水率 (%)\n9月16日現在';
    const p = parseKagawaTameikeText(t);
    expect(p.published).toEqual(['宮池', '石神池', '奈良須池']);
    expect(p.rows).toEqual([{ name: '奈良須池', storageRate: 1 }]);
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
  test('finds the daily chosui PDF on the かがわの水 page', async () => {
    const html = await Bun.file(`${DIR}kfvn_20260927.html`).text();
    expect(findLatestPdfUrl(html)).toBe(
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
  test('reads the 宝山湖 rate, stamped at the stated hour JST', async () => {
    // Re-captured 2026-09-28: byte-identical to this fixture. The page's
    // earlier blocks (早明浦 13.9%, 県内15ダム 92.2%, ため池 83%) must not leak in.
    const html = await Bun.file(`${DIR}kfvn_20260927.html`).text();
    expect(parseHozankoHtml(html)).toEqual({
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

  test('a missing or zero figure is published but carries no rate', () => {
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

describe('chooseMaster', () => {
  const m = (id: number, name: string, completedYear: number | null = null) =>
    ({ id: BigInt(id), name, completedYear, stamp: null }) as BindableMaster;

  test('公渕池 (PDF) binds 公淵池 (master)', () => {
    expect(chooseMaster('公渕池', [m(1, '公淵池'), m(2, '城池')])).toBe(1n);
  });

  test('満濃池 binds the completed （再） twin', () => {
    expect(chooseMaster('満濃池', [m(1, '満濃池（元）', 704), m(2, '満濃池（再）', 1959)])).toBe(
      2n,
    );
  });

  test('a generic name binds only on an exact stem, never a prefix', () => {
    expect(chooseMaster('新池', [m(1, '新中山池'), m(2, '新池田')])).toBeNull();
    expect(chooseMaster('神内池', [m(1, '神内上池'), m(2, '神内池')])).toBe(2n);
  });
});

describe('chooseHozanko', () => {
  const m = (id: number, name: string, ndi: string | null, stamp: string | null = null) => ({
    id: BigInt(id),
    name,
    completedYear: null,
    stamp,
    ndi,
  });

  test('binds 香川用水調整池 by its NDI id, not by name', () => {
    expect(chooseHozanko([m(1, '宝山池', '9999'), m(2, '香川用水調整池', '2170')])).toBe(2n);
  });

  test('an existing stamp wins over the NDI pin', () => {
    expect(chooseHozanko([m(1, '香川用水調整池', '2170'), m(3, 'x', null, '宝山湖')])).toBe(3n);
  });

  test('no NDI 2170 among the masters leaves it unbound', () => {
    expect(chooseHozanko([m(1, '宝山湖', null)])).toBeNull();
  });
});

describe('readPonds — a broken PDF must not cost 宝山湖 its write', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const html = '<a href="/documents/5847/chosui20260925.pdf">b</a>';

  test('a fetch that times out is logged and yields null', async () => {
    globalThis.fetch = (async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }) as unknown as typeof fetch;
    const logs: string[] = [];
    expect(await readPonds(html, {}, (s) => logs.push(s))).toBeNull();
    expect(logs.join('\n')).toContain('timed out');
  });

  test('bytes that are not a PDF are logged and yield null', async () => {
    globalThis.fetch = (async () =>
      new Response('<html>メンテナンス中</html>')) as unknown as typeof fetch;
    const logs: string[] = [];
    expect(await readPonds(html, {}, (s) => logs.push(s))).toBeNull();
    expect(logs.join('\n')).toContain('PDF unreadable');
  });
});
