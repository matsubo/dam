// Parser tests for 新潟県 佐渡地域振興局「農業用ダムの貯水量情報」.
//
// Real pages captured 2026-09-27 (tests/fixtures/sado_nourin): the index and
// two of the seven per-dam pages — 藤津川 because its rate is typeset as
// 「54<span>%</span>」.

import { describe, expect, test } from 'bun:test';
import type { BindableMaster } from '@dam/core/dam_binding';
import { chooseMaster, parseSadoDamLinks, parseSadoDamPage } from './ingest_sado_nourin.ts';

const DIR = new URL('../../../../tests/fixtures/sado_nourin/', import.meta.url).pathname;

describe('parseSadoDamLinks', () => {
  test('lists the seven 県営 dams once each, sidebar repeats dropped', async () => {
    const links = parseSadoDamLinks(await Bun.file(`${DIR}index_20260927.html`).text());
    expect(links.map((l) => l.name)).toEqual([
      '羽茂ダム',
      '竹田川ダム',
      '小倉川ダム',
      '藤津川ダム',
      '新穂ダム',
      '新穂第2ダム',
      '佐和田ダム',
    ]);
    expect(links[0]?.url).toBe(
      'https://www.pref.niigata.lg.jp/site/sado-nourinsuisan-nouson/1122070000.html',
    );
  });
});

describe('parseSadoDamPage', () => {
  test('reads volume, rate and the survey date (JST midnight) from 羽茂ダム', async () => {
    const page = parseSadoDamPage(await Bun.file(`${DIR}1122070000_hamochi_20260927.html`).text());
    expect(page).toEqual({
      name: '羽茂ダム',
      observedAt: new Date('2026-08-14T15:00:00.000Z'),
      capacityM3: 460_000,
      storageVolumeM3: 367_800,
      storageRate: 0.8,
    });
  });

  test('reads a rate whose % sign is in its own span (藤津川ダム)', async () => {
    const page = parseSadoDamPage(
      await Bun.file(`${DIR}1122020000_fujitsugawa_20260927.html`).text(),
    );
    expect(page?.storageVolumeM3).toBe(386_509);
    expect(page?.storageRate).toBe(0.54);
    expect(page?.capacityM3).toBe(718_000);
  });

  test('drops a page whose rate contradicts its own volume / 有効貯水量', () => {
    const html =
      '<h1>【佐渡】羽茂ダムの貯水量情報</h1><li>有効貯水量　460,000立法メートル</li>' +
      '<p>令和8年8月15日時点の貯水量は、367,800立法メートルで貯水率は40%、直近10か年平均と比べ152%の貯水率です。</p>';
    expect(parseSadoDamPage(html)).toBeNull();
  });
});

describe('chooseMaster', () => {
  const m = (id: number, name: string) =>
    ({ id: BigInt(id), name, completedYear: null, stamp: null }) as BindableMaster;

  test('新穂ダム binds 新穂, not 新穂第2', () => {
    expect(chooseMaster('新穂ダム', [m(1, '新穂第2'), m(2, '新穂')])).toBe(2n);
    expect(chooseMaster('新穂第2ダム', [m(1, '新穂第2'), m(2, '新穂')])).toBe(1n);
  });
});
