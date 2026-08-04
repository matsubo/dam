// Fallback cover-image scraper for dams that lack a Damnet photo.
// Queries the Japanese Wikipedia API for the dam's article, extracts the
// page's `pageimage` thumbnail (delivered from upload.wikimedia.org), and
// stores it in `dams.image_url`.
//
// Title resolution tries, in order:
//   1. `{name}ダム`        (most common — e.g. 黒部ダム, 徳山ダム)
//   2. `{name}`             (when the master name already includes ダム)
//   3. `{name}ダム ({pref})` (disambiguated form for collisions)
//
// Hits to ja.wikipedia.org are rate-limited at concurrency=4 to be polite to
// the public API.
//
// Usage:
//   bun run bin/fetch_dam_images_wikipedia.ts [--limit N] [--concurrency C]
//
// Notes:
//   - Only processes dams where `image_url IS NULL` so the Damnet-found
//     covers (411 dams) stay untouched.
//   - The Wikipedia thumbnail URLs land on upload.wikimedia.org;
//     next.config.ts needs that host in `images.remotePatterns`.
import { sql } from '../packages/db/src/client.ts';

const PREF_NAME: Record<string, string> = {
  '01': '北海道',
  '02': '青森県',
  '03': '岩手県',
  '04': '宮城県',
  '05': '秋田県',
  '06': '山形県',
  '07': '福島県',
  '08': '茨城県',
  '09': '栃木県',
  '10': '群馬県',
  '11': '埼玉県',
  '12': '千葉県',
  '13': '東京都',
  '14': '神奈川県',
  '15': '新潟県',
  '16': '富山県',
  '17': '石川県',
  '18': '福井県',
  '19': '山梨県',
  '20': '長野県',
  '21': '岐阜県',
  '22': '静岡県',
  '23': '愛知県',
  '24': '三重県',
  '25': '滋賀県',
  '26': '京都府',
  '27': '大阪府',
  '28': '兵庫県',
  '29': '奈良県',
  '30': '和歌山県',
  '31': '鳥取県',
  '32': '島根県',
  '33': '岡山県',
  '34': '広島県',
  '35': '山口県',
  '36': '徳島県',
  '37': '香川県',
  '38': '愛媛県',
  '39': '高知県',
  '40': '福岡県',
  '41': '佐賀県',
  '42': '長崎県',
  '43': '熊本県',
  '44': '大分県',
  '45': '宮崎県',
  '46': '鹿児島県',
  '47': '沖縄県',
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const limitFlag = args.indexOf('--limit');
  const limit = limitFlag >= 0 ? Number(args[limitFlag + 1] ?? '0') : 0;
  const concurrencyFlag = args.indexOf('--concurrency');
  const concurrency = concurrencyFlag >= 0 ? Number(args[concurrencyFlag + 1] ?? '4') : 4;

  const UA =
    process.env.HTTP_USER_AGENT ??
    `dam-data-platform/0.1 (${process.env.HTTP_CONTACT_EMAIL ?? 'matsubokkuri@gmail.com'})`;

  interface Row {
    id: string;
    name: string;
    pref_code: string;
  }

  const rows = await sql<Row[]>`
    SELECT id::TEXT, name, pref_code
    FROM dams
    WHERE image_url IS NULL
    ORDER BY total_capacity_m3 DESC NULLS LAST, id
    ${limit ? sql`LIMIT ${limit}` : sql``}
  `;
  console.log(`fetching Wikipedia covers for ${rows.length} dams (concurrency=${concurrency})`);

  let done = 0;
  let found = 0;
  let missing = 0;
  let errored = 0;

  async function tryTitle(title: string): Promise<string | null> {
    const url = `https://ja.wikipedia.org/w/api.php?action=query&format=json&prop=pageimages&pithumbsize=1024&redirects=1&titles=${encodeURIComponent(title)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      query?: {
        pages?: Record<string, { thumbnail?: { source?: string }; missing?: '' | true }>;
      };
    };
    const pages = body.query?.pages ?? {};
    for (const p of Object.values(pages)) {
      if ('missing' in p && p.missing !== undefined) continue;
      if (p.thumbnail?.source) return p.thumbnail.source;
    }
    return null;
  }

  async function processOne(r: Row): Promise<void> {
    try {
      const name = r.name.trim();
      const pref = PREF_NAME[r.pref_code] ?? '';
      // Strip a trailing 「（再）」/「（元）」 etc. that Damnet uses for redevelopments
      // — the Wikipedia article almost never has the parenthetical.
      const stripped = name.replace(/[（(].*?[）)]\s*$/g, '').trim();
      const candidates: string[] = [];
      // Order matters — first hit wins.
      if (!/ダム$/.test(stripped)) candidates.push(`${stripped}ダム`);
      candidates.push(stripped);
      if (pref && !/ダム$/.test(stripped)) candidates.push(`${stripped}ダム (${pref})`);
      let img: string | null = null;
      for (const t of candidates) {
        img = await tryTitle(t);
        if (img) break;
      }
      if (!img) {
        missing += 1;
        return;
      }
      await sql`UPDATE dams SET image_url = ${img}, updated_at = NOW() WHERE id = ${r.id}::BIGINT`;
      found += 1;
    } catch (err) {
      errored += 1;
      if (errored <= 5) console.error('  err', r.name, (err as Error).message);
    } finally {
      done += 1;
      if (done % 100 === 0) {
        console.log(
          `  progress: ${done}/${rows.length} (found=${found}, missing=${missing}, err=${errored})`,
        );
      }
    }
  }

  const queue = [...rows];
  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const r = queue.shift();
      if (!r) return;
      await processOne(r);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  console.log(`\ndone: found=${found}, missing=${missing}, errored=${errored} of ${rows.length}`);
}

main()
  .then(() => sql.end())
  .catch((e) => {
    console.error(e);
    sql.end();
    process.exit(1);
  });
