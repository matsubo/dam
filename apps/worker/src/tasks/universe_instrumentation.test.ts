import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from '@dam/db/client';

// /coverage can only say "no provider publishes this dam" once EVERY
// observation-producing task has recorded what its provider publishes. A task
// that ingests observations but never calls recordUniverse silently leaves its
// dams in 未調査 forever — and worse, if it were ever miscounted as scanned it
// would declare its dams unpublished. This test is that rollout's checklist.

const DIR = import.meta.dir;

/** Tasks that legitimately cannot enumerate a provider's published list. */
const EXEMPT = new Map<string, string>([
  [
    'ingest_kasenbosai_v2.ts',
    'Targets are read back from dams.external_ids, so this task cannot see the ' +
      'catalogue. kasenbosai’s universe is recorded by match_kasenbosai.ts.',
  ],
  [
    'backfill_jwa_junpo.ts',
    'Backfill re-reads dams already matched by ingest_jwa_junpo.ts, which records ' +
      'the universe.',
  ],
  [
    'backfill_suimon_run.ts',
    'Backfill walks dams already in the master; suimon publishes no station list ' +
      'we can enumerate.',
  ],
  [
    'backfill_mudam.ts',
    'NILIM historical dump, matched by coordinates against the master rather than ' +
      'from a published station list.',
  ],
]);

function ingestTasks(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .filter((f) => {
      const src = readFileSync(join(DIR, f), 'utf8');
      return src.includes('upsertObservations') && /SOURCE_ID|sourceId:/.test(src);
    })
    .sort();
}

/** Source ids a file writes observations under. */
function sourceIdsOf(src: string): string[] {
  const ids = new Set<string>();
  const konst = src.match(/SOURCE_ID\s*=\s*'([^']+)'/)?.[1];
  if (konst) ids.add(konst);
  for (const m of src.matchAll(/sourceId:\s*'([^']+)'/g)) if (m[1]) ids.add(m[1]);
  return [...ids];
}

/** Source ids recorded by some task other than `exclude`. */
function recordedSourceIds(exclude: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const f of readdirSync(DIR).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !exclude.has(f),
  )) {
    const src = readFileSync(join(DIR, f), 'utf8');
    if (!src.includes('recordUniverse(')) continue;
    for (const m of src.matchAll(/recordUniverse\(\s*'([^']+)'/g)) if (m[1]) out.add(m[1]);
    if (/recordUniverse\(\s*SOURCE_ID/.test(src)) {
      const konst = src.match(/SOURCE_ID\s*=\s*'([^']+)'/)?.[1];
      if (konst) out.add(konst);
    }
  }
  return out;
}

describe('source_universe instrumentation rollout', () => {
  test('every observation-ingesting task records what its provider publishes', () => {
    const missing = ingestTasks().filter((f) => {
      if (EXEMPT.has(f)) return false;
      return !readFileSync(join(DIR, f), 'utf8').includes('recordUniverse');
    });
    expect(missing).toEqual([]);
  });

  test('exemptions all name a task that still exists', () => {
    const present = new Set(readdirSync(DIR));
    expect([...EXEMPT.keys()].filter((f) => !present.has(f))).toEqual([]);
  });

  test('no exempted task leaves its source holding the gate open', async () => {
    // The EXEMPT list above and the SQL gate in `classifyDamCoverage` were
    // never tied together, and that gap is what broke /coverage: exempting a
    // task says nothing about its source_id, which stays in source_priorities
    // as an active observation provider with no recorded scan — and one such
    // row keeps EVERY dam out of `not_published` forever. `nagasaki-kasen` sat
    // there for months on an exemption whose stated reason ("its universe comes
    // from the matcher") was simply untrue.
    //
    // So check the thing that actually matters: a source a task is exempted
    // for must either be recorded by some OTHER task, or be outside the gate
    // (inactive, not an observation provider, not enumerable, or historical).
    const exemptIds = [...EXEMPT.keys()].flatMap((f) =>
      sourceIdsOf(readFileSync(join(DIR, f), 'utf8')),
    );
    const recorded = recordedSourceIds(new Set(EXEMPT.keys()));
    const inGate = await sql<{ source_id: string }[]>`
      SELECT source_id FROM source_priorities
      WHERE source_id IN ${sql(exemptIds)}
        AND active AND provides_observations AND universe_enumerable
        AND NOT historical_only
    `;
    const offenders = inGate.map((r) => r.source_id).filter((id) => !recorded.has(id));
    expect(offenders).toEqual([]);
  });

  test('no task records its universe from inside the per-row loop', () => {
    // `recordUniverse` stamps a completed scan, so it must see the whole list
    // at once. Calling it per row would stamp a scan on the first station and
    // report a universe of one.
    //
    // NOTE on what is deliberately NOT tested here: "unmatched rows are
    // recorded too". That is the invariant that matters most, and two
    // successive attempts to check it by text matching both cried wolf — one
    // on `resolvedDamId: chooseMaster(...)` (correct code, unrecognised
    // shape), one on files that build the list with a Map, and on a header
    // comment containing the words "no master match". The valid shapes are
    // genuinely diverse: push-before-`continue` in the match loop, or a
    // separate loop over the provider's catalogue constant. It is enforced by
    // review of the diff, not statically — a test that produces false
    // positives just teaches people to ignore it.
    const offenders: string[] = [];
    for (const f of ingestTasks()) {
      const src = readFileSync(join(DIR, f), 'utf8');
      const calls = [...src.matchAll(/await recordUniverse\(/g)];
      if (calls.length === 0) continue;
      for (const c of calls) {
        // Walk back to the enclosing statement; a call sitting inside a
        // `for (` / `while (` body at the same indent depth is the error.
        const before = src.slice(0, c.index);
        const line = before.slice(before.lastIndexOf('\n') + 1);
        const indent = line.length - line.trimStart().length;
        // Loop bodies in this codebase are indented deeper than 4 spaces at
        // the point recordUniverse should appear (function body level).
        if (indent > 4) offenders.push(`${f} (indent ${indent})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
