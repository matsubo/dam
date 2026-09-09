import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
    'ingest_nagasaki_kasen.ts',
    'Same DB-derived target list as kasenbosai_v2; its universe comes from the ' +
      'matcher, not the fetcher.',
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
