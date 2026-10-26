// Markdown twin of /dams/[slug], served when proxy.ts rewrites a dam page
// request that arrives with `Accept: text/markdown`, and linked from the
// page's <link rel="alternate" type="text/markdown">. Same facts as the HTML
// page — specs, location, latest reading and its source — without the chart,
// map and navigation an agent would otherwise have to strip.
import { PREFECTURES } from '@dam/core/prefectures';
import { providerAvailability, triageDam } from '@dam/db/repo/coverage';
import { canonicalTwin, findDamBySlug, latestObservation } from '@dam/db/repo/dams';
import { damDisplayName } from '../../../../lib/dam-name.ts';
import { fmtCapacityMcm, fmtDate, fmtN, fmtPct } from '../../../../lib/format.ts';
import { markdownResponse } from '../../../../lib/markdown-response.ts';
import { displayRate } from '../../../../lib/rate-basis.ts';

export const dynamic = 'force-dynamic';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://dam.teraren.com';
const PREF_NAME = new Map(PREFECTURES.map((p) => [p.code, p.name]));

/**
 * `- label: value` for each fact that is known. The formatters print '—' for
 * a value they cannot show (a 0 or sentinel capacity), so that is unknown too.
 */
function facts(rows: Array<[string, string | null]>): string {
  return rows
    .filter((r): r is [string, string] => r[1] !== null && r[1] !== '—')
    .map(([label, value]) => `- ${label}: ${value}`)
    .join('\n');
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const d = await findDamBySlug(slug);
  if (!d) return markdownResponse(`# Not found\n\nNo dam has the slug \`${slug}\`.\n`, 404);

  const dn = damDisplayName(d.name);
  const pref = PREF_NAME.get(d.prefCode) ?? d.prefCode;
  const [latest, triage] = await Promise.all([latestObservation(d.id), triageDam(d.id)]);
  const twin = latest ? null : await canonicalTwin(d.id);
  const notPublished = providerAvailability(triage?.status ?? 'unknown') === 'none';
  const path = encodeURIComponent(slug);
  const page = `${SITE_URL}/dams/${path}`;

  const spec = facts([
    ['ダム名', d.nameKana ? `${d.name}（${d.nameKana}）` : d.name],
    ['都道府県', pref],
    ['左岸所在地', d.leftBankLocation],
    ['座標', `${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}`],
    [
      '標高',
      d.elevationM != null && Number.isFinite(d.elevationM)
        ? `${Math.round(d.elevationM).toLocaleString('ja-JP')} m`
        : null,
    ],
    [
      '水系',
      d.watershedSlug && d.watershedName
        ? `[${d.watershedName}水系](${SITE_URL}/watersheds/${encodeURIComponent(d.watershedSlug)})`
        : null,
    ],
    ['管理者', d.manager],
    ['型式', d.type],
    ['堤高', d.heightM ? `${fmtN(d.heightM)} m` : null],
    ['堤長', d.crestLengthM ? `${fmtN(d.crestLengthM)} m` : null],
    ['総貯水容量', d.totalCapacityM3 ? fmtCapacityMcm(d.totalCapacityM3) : null],
    ['有効貯水容量', d.effectiveCapacityM3 ? fmtCapacityMcm(d.effectiveCapacityM3) : null],
    ['流域面積', d.watershedAreaKm2 ? `${fmtN(d.watershedAreaKm2)} km²` : null],
    ['湛水面積', d.reservoirAreaKm2 ? `${fmtN(d.reservoirAreaKm2)} km²` : null],
    ['竣工', d.completedYear ? `${d.completedYear}年` : null],
  ]);

  let reading: string;
  if (latest && !notPublished) {
    const cap = latest.effectiveActiveCapacityM3 ? Number(latest.effectiveActiveCapacityM3) : null;
    const rate = displayRate(cap, latest.storageVolumeM3 ? Number(latest.storageVolumeM3) : null);
    reading = facts([
      ['観測日時', fmtDate(latest.observedAt)],
      ['貯水量', latest.storageVolumeM3 ? fmtCapacityMcm(latest.storageVolumeM3) : null],
      [
        '貯水率',
        rate === null
          ? null
          : latest.storageRateOrigin === 'computed'
            ? `${fmtPct(rate)}（出典の公表値ではなく、貯水量 ÷ ${cap ? fmtCapacityMcm(cap) : '有効貯水容量'}で当サイトが算出）`
            : fmtPct(rate),
      ],
      ['流入量', latest.inflowM3s ? `${fmtN(latest.inflowM3s)} m³/s` : null],
      ['放流量', latest.outflowM3s ? `${fmtN(latest.outflowM3s)} m³/s` : null],
      ['水位', latest.waterLevelM ? `${fmtN(latest.waterLevelM)} m` : null],
      ['出典', `${latest.sourceId}（${SITE_URL}/sources/${encodeURIComponent(latest.sourceId)}）`],
    ]);
  } else if (twin) {
    reading = `このダムの観測値は [${damDisplayName(twin.name)}](${SITE_URL}/dams/${encodeURIComponent(twin.slug)}) に掲載しています。`;
  } else if (notPublished) {
    reading = 'このダムの観測値を公開しているデータ提供元はありません（提供元なし）。';
  } else {
    reading = '観測値（貯水率・貯水量）は未提供です。';
  }

  const api = `${SITE_URL}/api/v1/dams/${path}`;
  const body = `# ${dn}（${pref}）

> ${dn}の諸元・所在地と最新の観測値。Dam Data Japan が各データ提供元の公開値を収集・整理したものです。

- HTML: ${page}

## 諸元

${spec}

## 最新観測値

${reading}

表示値は各提供元の公開値を自動で取得したもので、遅延・欠測・誤りを含むことがあります。避難などの判断には、自治体・気象庁・川の防災情報（https://www.river.go.jp/）などの一次情報を必ず確認してください。

## データの取得

REST API（HAL+JSON、要 API キー: ${SITE_URL}/account/keys、仕様: ${SITE_URL}/api/docs）

- ダム: ${api}
- 時系列: ${api}/observations?interval=daily（hourly / monthly も可、\`format=csv\` で CSV）
- 利用条件: ${SITE_URL}/legal/terms
`;
  return markdownResponse(body);
}
