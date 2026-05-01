// apps/worker/src/tasks/master_refresh_damnet.ts
import { importDamnetDetail, parseDamnetDetail, parseDamnetList } from '@dam/adapters-damnet';
import { HttpClient } from '@dam/core/http_client';
import type { Task } from 'graphile-worker';

const LIST_URL = process.env.DAMNET_LIST_URL;
const BASE_URL = process.env.DAMNET_BASE_URL ?? 'https://damnet.or.jp';

const task: Task = async (_payload, helpers) => {
  if (!LIST_URL) {
    helpers.logger.error('DAMNET_LIST_URL not set');
    return;
  }
  const c = new HttpClient({
    userAgent: 'DamDataPlatform/0.1 (+https://example.com/bot; matsubokkuri@gmail.com)',
    minIntervalMs: 2000,
    maxRetries: 3,
  });
  const list = parseDamnetList((await c.get(LIST_URL)).bodyText, BASE_URL);
  helpers.logger.info(`damnet list size: ${list.length}`);

  let matched = 0;
  let review = 0;
  let none = 0;
  for (const item of list) {
    const r = await c.get(item.detailUrl);
    if (r.status !== 200) {
      helpers.logger.warn(`HTTP ${r.status} ${item.detailUrl}`);
      continue;
    }
    const detail = parseDamnetDetail(r.bodyText, item.damnetId);
    const out = await importDamnetDetail(detail);
    if (out.outcome === 'matched') matched++;
    else if (out.outcome === 'review_enqueued') review++;
    else none++;
  }
  helpers.logger.info(`damnet matched=${matched} review=${review} none=${none}`);
};

export default task;
