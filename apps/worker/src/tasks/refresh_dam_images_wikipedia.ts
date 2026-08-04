// Periodic Wikipedia/Wikimedia cover-image refresh.
// Fallback for dams that lack a Damnet photo — queries ja.wikipedia.org for
// the dam's article and pulls its `pageimage` thumbnail.
import { sql } from '@dam/db/client';
import type { Task } from 'graphile-worker';

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

const refreshDamImagesWikipedia: Task = async (_payload, _helpers) => {
  const UA =
    process.env.HTTP_USER_AGENT ??
    `dam-data-platform/0.1 (${process.env.HTTP_CONTACT_EMAIL ?? 'ops@example.com'})`;

  const rows = await sql<{ id: string; name: string; pref_code: string }[]>`
    SELECT id::TEXT, name, pref_code
    FROM dams
    WHERE image_url IS NULL
    ORDER BY total_capacity_m3 DESC NULLS LAST, id
  `;
  async function tryTitle(title: string): Promise<string | null> {
    const url = `https://ja.wikipedia.org/w/api.php?action=query&format=json&prop=pageimages&pithumbsize=1024&redirects=1&titles=${encodeURIComponent(title)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      query?: { pages?: Record<string, { thumbnail?: { source?: string }; missing?: '' | true }> };
    };
    for (const p of Object.values(body.query?.pages ?? {})) {
      if ('missing' in p && p.missing !== undefined) continue;
      if (p.thumbnail?.source) return p.thumbnail.source;
    }
    return null;
  }

  let found = 0;
  for (const r of rows) {
    try {
      const stripped = r.name.replace(/[（(].*?[）)]\s*$/g, '').trim();
      const pref = PREF_NAME[r.pref_code] ?? '';
      const candidates: string[] = [];
      if (!/ダム$/.test(stripped)) candidates.push(`${stripped}ダム`);
      candidates.push(stripped);
      if (pref && !/ダム$/.test(stripped)) candidates.push(`${stripped}ダム (${pref})`);
      let img: string | null = null;
      for (const t of candidates) {
        img = await tryTitle(t);
        if (img) break;
      }
      if (img) {
        await sql`UPDATE dams SET image_url = ${img}, updated_at = NOW() WHERE id = ${r.id}::BIGINT`;
        found += 1;
      }
      await new Promise((r) => setTimeout(r, 150));
    } catch {
      // skip; retry next run
    }
  }
  console.log(`[images:refresh:wikipedia] checked=${rows.length} found=${found}`);
};

export default refreshDamImagesWikipedia;
