// Fixture → universe entries for 新潟県 佐渡地域振興局「農業用ダムの貯水量情報」,
// no database: binding and writing belong to the ingest run.
//
// Real pages captured 2026-09-27 (tests/fixtures/sado_nourin): the index and
// two of the seven per-dam pages — 藤津川 because its rate is typeset as
// 「54<span>%</span>」.

import { describe, expect, test } from 'bun:test';
import type { Reading } from '../ingest/types.ts';
import {
  type FetchPage,
  parseSadoDamLinks,
  sadoDamReading,
  sadoNourinEntries,
} from './ingest_sado_nourin.ts';

const DIR = new URL('../../../../tests/fixtures/sado_nourin/', import.meta.url).pathname;
const index = await Bun.file(`${DIR}index_20260927.html`).text();

describe('parseSadoDamLinks', () => {
  test('lists the seven 県営 dams once each, sidebar repeats dropped', () => {
    const links = parseSadoDamLinks(index);
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

describe('sadoDamReading', () => {
  test('reads volume, rate and the survey date (JST midnight) from 羽茂ダム', async () => {
    const r = sadoDamReading(await Bun.file(`${DIR}1122070000_hamochi_20260927.html`).text());
    expect(r).toEqual({
      state: 'values',
      observations: [
        {
          observedAt: new Date('2026-08-14T15:00:00.000Z'),
          storageVolumeM3: 367_800,
          storageRate: 0.8,
        },
      ],
    });
  });

  test('reads a rate whose % sign is in its own span (藤津川ダム)', async () => {
    const r = sadoDamReading(await Bun.file(`${DIR}1122020000_fujitsugawa_20260927.html`).text());
    if (r.state !== 'values') throw new Error(r.state);
    expect(r.observations[0]?.storageVolumeM3).toBe(386_509);
    expect(r.observations[0]?.storageRate).toBe(0.54);
  });

  test('a page whose rate contradicts its own volume / 有効貯水量 is unreadable', () => {
    const html =
      '<h1>【佐渡】羽茂ダムの貯水量情報</h1><li>有効貯水量　460,000立法メートル</li>' +
      '<p>令和8年8月15日時点の貯水量は、367,800立法メートルで貯水率は40%、直近10か年平均と比べ152%の貯水率です。</p>';
    expect(sadoDamReading(html).state).toBe('unreadable');
  });
});

describe('sadoNourinEntries', () => {
  const pages: Record<string, string> = {
    'https://www.pref.niigata.lg.jp/site/sado-nourinsuisan-nouson/1122070000.html':
      '1122070000_hamochi_20260927.html',
  };
  const fetchPage: FetchPage = async (url) => {
    const file = pages[url];
    if (!file) throw new Error(`HTTP 404 for ${url}`);
    return Bun.file(`${DIR}${file}`).text();
  };
  const entries = sadoNourinEntries(index, fetchPage);

  async function read(name: string): Promise<Reading> {
    const r = entries.find((e) => e.name === name)?.reading;
    if (!r) throw new Error(`no ${name}`);
    return typeof r === 'function' ? r(null) : r;
  }

  test('lists every linked dam, exact names only: 新穂 must not take 新穂第2', () => {
    expect(entries).toHaveLength(7);
    for (const e of entries) {
      expect(e).toMatchObject({ key: e.name, pref: '15', bind: { exact: true } });
    }
  });

  test('each dam reads its own page', async () => {
    expect((await read('羽茂ダム')).state).toBe('values');
  });

  test('a page that cannot be fetched throws, so the run records that dam unreadable', async () => {
    await expect(read('新穂ダム')).rejects.toThrow('HTTP 404');
  });
});
