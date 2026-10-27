// apps/worker/src/tasks/ingest_jwa_kiso_rt.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).
//
// Fixture is a verbatim UTF-8 capture of 水資源機構 中部支社 リアルタイム情報
// 木曽川水系 (water.go.jp/mizu/chubu/realtime/index.html) taken 2026-09-28
// 12:54 JST, 観測時刻 2026年09月28日 12時40分. Page order: 牧尾, 味噌川,
// 阿木川, 岩屋, 徳山, 打上調整池 (貯水位 only), 中里貯水池 (貯水位 and
// 有効貯水量 only), 宮川/菰野/加佐登調整池, then 長良川河口堰 (堰上流水位 1.34,
// 堰下流水位 -0.63, 流入量 193.44, 流出量 214.77) and 木曽川大堰 (堰上流水位 3.60,
// 流入量 542.99, 放流量 535.39).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bindEntry, type Master } from '../ingest/bind.ts';
import type { Entry, Observed } from '../ingest/types.ts';
import { kisoEntries } from './ingest_jwa_kiso_rt.ts';
import { parseJwaChubuRealtime } from './jwa_chubu_realtime.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/jwa_kiso_rt/index_2026-09-28.html',
);

async function entries(edit: (html: string) => string = (h) => h): Promise<Entry[]> {
  const { observedAt, facilities } = parseJwaChubuRealtime(edit(await readFile(FIXTURE, 'utf8')));
  if (!observedAt) throw new Error('no 観測時刻');
  return kisoEntries(facilities, observedAt);
}

function observed(list: Entry[], key: string): Omit<Observed, 'observedAt'> {
  const r = list.find((e) => e.key === key)?.reading;
  if (!r || typeof r === 'function' || r.state !== 'values') throw new Error(`${key}: no values`);
  const [o] = r.observations;
  if (!o) throw new Error(`${key}: no observation`);
  const { observedAt: _, ...quantities } = o;
  return quantities;
}

describe('kisoEntries', () => {
  test('lists all 12 facilities, each read from its own table', async () => {
    const list = await entries();
    expect(list.map((e) => e.key)).toEqual([
      '牧尾ダム',
      '味噌川ダム',
      '阿木川ダム',
      '岩屋ダム',
      '徳山ダム',
      '打上調整池',
      '中里貯水池',
      '宮川調整池',
      '菰野調整池',
      '加佐登調整池',
      '長良川河口堰',
      '木曽川大堰',
    ]);
    const r = list[0]?.reading;
    if (!r || typeof r === 'function' || r.state !== 'values') throw new Error('no values');
    expect(r.observations[0]?.observedAt.toISOString()).toBe('2026-09-28T03:40:00.000Z');
    expect(observed(list, '牧尾ダム')).toEqual({
      waterLevelM: 877.75,
      storageVolumeM3: 60_877_000,
      inflowM3s: 375.6,
      outflowM3s: 392.78,
    });
    // 中里's table has no flows; the 193.44 and 535.39 further down the page
    // belong to 長良川河口堰 and 木曽川大堰.
    expect(observed(list, '中里貯水池')).toEqual({
      waterLevelM: 172.52,
      storageVolumeM3: 1_801_000,
      inflowM3s: null,
      outflowM3s: null,
    });
    expect(observed(list, '宮川調整池')).toEqual({
      waterLevelM: 121.09,
      storageVolumeM3: 357_000,
      inflowM3s: null,
      outflowM3s: null,
    });
  });

  test('a weir stores its 堰上流水位 as the level and 流出量 / 放流量 as the outflow', async () => {
    const list = await entries();
    expect(observed(list, '長良川河口堰')).toEqual({
      waterLevelM: 1.34,
      storageVolumeM3: null,
      inflowM3s: 193.44,
      outflowM3s: 214.77,
    });
    expect(observed(list, '木曽川大堰')).toEqual({
      waterLevelM: 3.6,
      storageVolumeM3: null,
      inflowM3s: 542.99,
      outflowM3s: 535.39,
    });
  });

  test('a facility with every cell cut is still listed, unreadable', async () => {
    const list = await entries((h) => h.replace('>213.12<', '>cc<'));
    expect(list).toHaveLength(12);
    expect(list.find((e) => e.key === '打上調整池')?.reading).toEqual({
      state: 'unreadable',
      why: 'no stored quantity printed ("cc" or blank)',
    });
  });
});

describe('中里貯水池 binds 三重用水 in 三重県', () => {
  // 中里貯水池 is 三重用水's reservoir (いなべ市, NDI 940; the jwa-chubu report
  // prints its 利水容量 16,000 千m³ = the master's 有効). Migration 0031 had
  // invented a 長野 '中里' for it, which carried the stamp on prod.
  const master = (id: number, prefCode: string, stamp: string | null): Master => ({
    id: BigInt(id),
    name: '中里',
    prefCode,
    completedYear: null,
    stamp,
    ndi: null,
    totalCapacityM3: null,
    activeCapacityM3: null,
  });

  test('searched in 三重 as 中里, exact names only', async () => {
    const nakazato = (await entries()).find((e) => e.key === '中里貯水池');
    expect(nakazato?.pref).toBe('24');
    expect(nakazato?.bind).toEqual({ name: '中里', exact: true });
  });

  test('the 三重 row wins over a 長野 namesake that holds the stamp', async () => {
    const nakazato = (await entries()).find((e) => e.key === '中里貯水池');
    if (!nakazato) throw new Error('no 中里貯水池');
    const masters = [master(1, '24', null), master(2, '20', '中里貯水池')];
    expect(bindEntry(nakazato, masters, false).dam?.id).toBe(1n);
  });
});
