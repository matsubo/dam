// From bound, read entries to the rows the run writes: pure.

import type { ObservationInput } from '@dam/db/repo/observations';
import type { UniverseRow } from '@dam/db/repo/source_universe';
import type { Binding } from './bind.ts';
import type { Entry, Observed, Reading } from './types.ts';

export interface ReadEntry {
  readonly entry: Entry;
  readonly binding: Binding;
  readonly reading: Reading;
}

export interface Plan {
  universe: UniverseRow[];
  stamps: { damId: bigint; key: string }[];
  observations: ObservationInput[];
  /** One line per entry that is unbound, unreadable, skipped or merged. */
  notes: string[];
  counts: Record<'listed' | 'bound' | 'values' | 'empty' | 'unreadable' | 'written', number>;
}

const QUANTITIES = [
  'storageVolumeM3',
  'storageRate',
  'inflowM3s',
  'outflowM3s',
  'waterLevelM',
  'rainfallMm',
] as const;

/** An observation with none of the six quantities is not data (GLOSSARY: Value). */
export function hasValue(o: Observed): boolean {
  return QUANTITIES.some((q) => o[q] != null);
}

const PREFERENCE: Record<Reading['state'], number> = { values: 0, empty: 1, unreadable: 2 };

/** Entries sharing a key become one: values over empty over unreadable, first wins a tie. */
export function mergeByKey(entries: readonly ReadEntry[], notes: string[]): ReadEntry[] {
  const byKey = new Map<string, ReadEntry>();
  for (const e of entries) {
    const seen = byKey.get(e.entry.key);
    if (!seen) {
      byKey.set(e.entry.key, e);
      continue;
    }
    notes.push(`${e.entry.key}: listed twice; kept the ${seen.reading.state} entry`);
    if (PREFERENCE[e.reading.state] < PREFERENCE[seen.reading.state]) byKey.set(e.entry.key, e);
  }
  return [...byKey.values()];
}

export function planWrites(sourceId: string, entries: readonly ReadEntry[], dated: boolean): Plan {
  const notes: string[] = [];
  const merged = mergeByKey(entries, notes);
  const counts = {
    listed: merged.length,
    bound: 0,
    values: 0,
    empty: 0,
    unreadable: 0,
    written: 0,
  };
  const universe: UniverseRow[] = [];
  const stamps: Plan['stamps'] = [];
  const observations = new Map<string, ObservationInput>();
  const damTaken = new Map<bigint, string>();

  for (const { entry, binding, reading: read } of merged) {
    let reading = read;
    const valued = reading.state === 'values' ? reading.observations.filter(hasValue) : [];
    if (reading.state === 'values' && valued.length === 0) {
      reading = { state: 'unreadable', why: 'values without a value' };
    }
    counts[reading.state] += 1;
    if (reading.state === 'unreadable') {
      notes.push(`${entry.key} ${entry.name}: unreadable (${reading.why})`);
    }

    const dam = binding.dam;
    if (dam) counts.bound += 1;
    else notes.push(`${entry.key} ${entry.name}: unbound (${binding.why})`);

    let writes = dam !== null && !entry.dontWrite && reading.state === 'values';
    if (dam && entry.dontWrite)
      notes.push(`${entry.key} ${entry.name}: not written (${entry.dontWrite})`);
    if (dam && !entry.dontWrite) {
      const holder = damTaken.get(dam.id);
      if (holder !== undefined) {
        notes.push(
          `${entry.key} ${entry.name}: dam ${dam.id} already fed by ${holder}; not written`,
        );
        writes = false;
      } else {
        damTaken.set(dam.id, entry.key);
        stamps.push({ damId: dam.id, key: entry.key });
      }
    }

    let newest: Date | null = null;
    if (writes && dam) {
      for (const o of valued) {
        observations.set(`${dam.id}|${o.observedAt.toISOString()}`, {
          observedAt: o.observedAt,
          damId: dam.id,
          sourceId,
          storageVolumeM3: o.storageVolumeM3 ?? null,
          storageRate: o.storageRate ?? null,
          inflowM3s: o.inflowM3s ?? null,
          outflowM3s: o.outflowM3s ?? null,
          waterLevelM: o.waterLevelM ?? null,
          rainfallMm: o.rainfallMm ?? null,
          rawSnapshotId: null,
          qualityFlag: 0,
        });
        if (!newest || o.observedAt > newest) newest = o.observedAt;
      }
    }

    universe.push({
      externalId: entry.key,
      name: entry.name,
      prefCode: typeof entry.pref === 'string' ? entry.pref : null,
      lat: entry.lat ?? null,
      lng: entry.lng ?? null,
      resolvedDamId: dam?.id ?? null,
      hasData: reading.state === 'values' ? true : reading.state === 'empty' ? false : null,
      publishedAt: dated ? newest : null,
    });
  }
  counts.written = observations.size;
  return { universe, stamps, observations: [...observations.values()], notes, counts };
}
