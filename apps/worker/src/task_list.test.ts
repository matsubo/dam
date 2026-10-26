import { describe, expect, test } from 'bun:test';
import { CRONTAB } from '@dam/core/crontab';
import { SOURCES } from '@dam/core/sources';
import { parseCrontab } from 'graphile-worker';
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
});
