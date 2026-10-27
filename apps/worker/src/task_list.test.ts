import { describe, expect, test } from 'bun:test';
import { CRONTAB } from '@dam/core/crontab';
import { SOURCES } from '@dam/core/sources';
import { parseCrontab } from 'graphile-worker';
import { ingestSourceOf } from './ingest/run.ts';
import { TASK_LIST } from './task_list.ts';

describe('TASK_LIST', () => {
  // graphile-worker queues a cron job whatever the task list says; a task
  // missing here leaves its jobs queued and never run.
  test('runs every scheduled task', () => {
    const scheduled = [...new Set(parseCrontab(CRONTAB).map((item) => item.task))];
    expect(scheduled.filter((task) => !(task in TASK_LIST))).toEqual([]);
  });

  // An ingest task no source declares has no priority row, no schedule and
  // no freshness check.
  test('every ingest task belongs to a declared source', () => {
    const declared = new Set(SOURCES.flatMap((s) => (s.ingest ? [s.ingest.task] : [])));
    const orphans = Object.keys(TASK_LIST).filter(
      (task) => task.startsWith('ingest:') && !declared.has(task),
    );
    expect(orphans).toEqual([]);
  });

  // /coverage can only say "no provider publishes this dam" once every
  // source records its whole published list. The ingest run does that by
  // construction, so every active source's ingest task must be built with
  // ingestTask, for its own id. kasenbosai is the one declared exception:
  // match:kasenbosai records its universe, ingest:kasenbosai-v2 only has_data.
  test('every active source ingests through the ingest run', () => {
    const scheduled = SOURCES.filter(
      (s) => s.status === 'active' && s.ingest && s.id !== 'kasenbosai',
    );
    const off = scheduled.flatMap((s) => {
      const task = s.ingest ? TASK_LIST[s.ingest.task] : undefined;
      return task && ingestSourceOf(task) === s.id ? [] : [s.id];
    });
    expect(off).toEqual([]);
  });
});
