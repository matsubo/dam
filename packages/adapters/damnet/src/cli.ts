import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { HttpClient } from '@dam/core/http_client';
import { sql } from '@dam/db/client';
import { parseDamnetDetail } from './detail_parser.ts';
import { importDamnetDetail } from './importer.ts';
import { parseDamnetList } from './list_scraper.ts';

async function readSource(s: string): Promise<string> {
  if (s.startsWith('http://') || s.startsWith('https://')) {
    const c = new HttpClient({
      userAgent: 'DamDataPlatform/0.1 (+https://example.com/bot; matsubokkuri@gmail.com)',
      minIntervalMs: 2000,
      maxRetries: 3,
    });
    const r = await c.get(s);
    if (r.status !== 200) throw new Error(`HTTP ${r.status} from ${s}`);
    return r.bodyText;
  }
  return readFile(s, 'utf8');
}

function extractDb4(url: string): string | null {
  const m = url.match(/db4=(\d+)/);
  return m ? (m[1] ?? null) : null;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      list: { type: 'string' },
      detail: { type: 'string' },
      base: { type: 'string', default: 'https://damnet.or.jp' },
      limit: { type: 'string' },
    },
  });

  if (values.detail) {
    const html = await readSource(values.detail);
    const detail = parseDamnetDetail(html, extractDb4(values.detail) ?? 'unknown');
    const r = await importDamnetDetail(detail);
    console.log(JSON.stringify(r));
    return;
  }

  if (values.list) {
    const html = await readSource(values.list);
    const items = parseDamnetList(html, values.base ?? 'https://damnet.or.jp');
    const limit = values.limit ? Number(values.limit) : items.length;
    let matched = 0;
    let review = 0;
    let none = 0;
    for (const item of items.slice(0, limit)) {
      const detailHtml = await readSource(item.detailUrl);
      const detail = parseDamnetDetail(detailHtml, item.damnetId);
      const r = await importDamnetDetail(detail);
      if (r.outcome === 'matched') matched++;
      else if (r.outcome === 'review_enqueued') review++;
      else none++;
    }
    console.log(`matched=${matched} review=${review} none=${none}`);
    return;
  }

  console.error('Pass --list <url-or-file> or --detail <url-or-file>');
  process.exit(2);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end({ timeout: 5 });
  });
