import { sql } from '@dam/db/client';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Breadcrumbs } from '../../components/breadcrumbs.tsx';
import { fmtDate, fmtDateOnly } from '../../lib/format.ts';
import { SOURCE_DETAILS } from '../../lib/source-details.ts';

export const dynamic = 'force-dynamic';
export const revalidate = 300;
export const metadata: Metadata = {
  title: 'データソースとデータ構造',
  description:
    '使用している外部データソース、ダム名寄せの方法、ER 図、欠損データの分布、観測値の粒度。',
  alternates: { canonical: '/sources' },
};

interface SourceRow {
  source_id: string;
  description: string | null;
  priority: number;
  active: boolean;
  last_fetched_at: Date | null;
  last_status: string | null;
}

interface CoverageRow {
  total: bigint;
  with_active: bigint;
  with_effective: bigint;
  with_kana: bigint;
  with_height: bigint;
  with_completed: bigint;
  with_image: bigint;
  with_purposes: bigint;
  with_watershed_area: bigint;
  with_damnet: bigint;
}

interface ObsCadenceRow {
  earliest: Date | null;
  latest: Date | null;
  total: bigint;
  last_24h: bigint;
  distinct_dams: bigint;
}

interface ObsBySourceRow {
  source_id: string;
  rows_30d: bigint;
  distinct_dams_30d: bigint;
  latest_observed_at: Date | null;
}

async function loadAll() {
  const [sources, coverage, cadence, bucketRows, redevRows, obsBySource] = await Promise.all([
    sql<SourceRow[]>`
      SELECT sp.source_id, sp.description, sp.priority, sp.active,
             lf.last_fetched_at, lf.last_status
      FROM source_priorities sp
      LEFT JOIN LATERAL (
        SELECT fetched_at AS last_fetched_at, parse_status AS last_status
        FROM raw_snapshots WHERE source_id = sp.source_id
        ORDER BY fetched_at DESC LIMIT 1
      ) lf ON TRUE
      ORDER BY sp.priority DESC
    `,
    sql<CoverageRow[]>`
      SELECT
        COUNT(*)                                                   AS total,
        COUNT(*) FILTER (WHERE active_capacity_m3 IS NOT NULL)     AS with_active,
        COUNT(*) FILTER (WHERE effective_capacity_m3 IS NOT NULL)  AS with_effective,
        COUNT(*) FILTER (WHERE name_kana IS NOT NULL)              AS with_kana,
        COUNT(*) FILTER (WHERE height_m IS NOT NULL)               AS with_height,
        COUNT(*) FILTER (WHERE completed_year IS NOT NULL)         AS with_completed,
        COUNT(*) FILTER (WHERE image_url IS NOT NULL)              AS with_image,
        COUNT(*) FILTER (WHERE purposes IS NOT NULL)               AS with_purposes,
        COUNT(*) FILTER (WHERE watershed_area_km2 IS NOT NULL)     AS with_watershed_area,
        COUNT(*) FILTER (WHERE external_ids ? 'damnet')            AS with_damnet
      FROM dams
    `,
    sql<ObsCadenceRow[]>`
      SELECT
        MIN(observed_at)                                            AS earliest,
        MAX(observed_at)                                            AS latest,
        COUNT(*)::BIGINT                                            AS total,
        COUNT(*) FILTER (WHERE observed_at > NOW() - INTERVAL '24 hours')::BIGINT AS last_24h,
        COUNT(DISTINCT dam_id)::BIGINT                              AS distinct_dams
      FROM observations
    `,
    sql<{ bucket: string; total: bigint; missing: bigint }[]>`
      SELECT
        CASE
          WHEN total_capacity_m3 IS NULL              THEN '不明'
          WHEN total_capacity_m3 >= 1e9               THEN '10億 m³ 以上'
          WHEN total_capacity_m3 >= 1e8               THEN '1〜10億 m³'
          WHEN total_capacity_m3 >= 1e7               THEN '1000万〜1億 m³'
          WHEN total_capacity_m3 >= 1e6               THEN '100〜1000万 m³'
          WHEN total_capacity_m3 >= 1e5               THEN '10〜100万 m³'
          ELSE '10万 m³ 未満'
        END                                                AS bucket,
        COUNT(*)::BIGINT                                   AS total,
        COUNT(*) FILTER (WHERE active_capacity_m3 IS NULL)::BIGINT AS missing
      FROM dams
      GROUP BY bucket
      ORDER BY MAX(COALESCE(total_capacity_m3, 0)) DESC
    `,
    sql<{ count: bigint }[]>`
      SELECT COUNT(*)::BIGINT AS count
      FROM dams
      WHERE name ~ '[（(](?:再|元|新)[）)]'
    `,
    sql<ObsBySourceRow[]>`
      SELECT
        source_id,
        COUNT(*)::BIGINT                            AS rows_30d,
        COUNT(DISTINCT dam_id)::BIGINT              AS distinct_dams_30d,
        MAX(observed_at)                            AS latest_observed_at
      FROM observations
      WHERE observed_at > NOW() - INTERVAL '30 days'
      GROUP BY source_id
    `,
  ]);
  const cov = coverage[0];
  const cad = cadence[0];
  if (!cov || !cad) throw new Error('sources/loadAll: aggregate query returned no rows');
  return {
    sources,
    coverage: cov,
    cadence: cad,
    buckets: bucketRows,
    redevCount: Number(redevRows[0]?.count ?? 0n),
    obsBySource: new Map(obsBySource.map((r) => [r.source_id, r])),
  };
}

// SOURCE_DETAILS moved to apps/web/lib/source-details.ts so /sources/[id]
// and components/source-badge.tsx can share the editorial metadata.
const SOURCE_DETAIL = SOURCE_DETAILS;

function pct(part: bigint | number, total: bigint | number): string {
  const p = Number(part);
  const t = Number(total);
  if (t === 0) return '—';
  return `${((p / t) * 100).toFixed(1)} %`;
}
const fmt = (n: bigint | number) => Number(n).toLocaleString('ja-JP');

export default async function SourcesPage() {
  const data = await loadAll();
  const c = data.coverage;

  return (
    <div className="max-w-7xl mx-auto px-5 md:px-10 py-8 space-y-12">
      <div>
        <Breadcrumbs items={[{ label: 'ホーム', href: '/' }, { label: 'データソース' }]} />
        <h1 className="text-3xl font-semibold mb-2">データソースとデータ構造</h1>
        <p className="text-sm text-on-surface-variant max-w-3xl">
          このサイトのデータ起源、ダム名寄せの方法、テーブル構造、欠損の分布、観測の粒度をまとめています。
          外部公開データのみを利用し、独自の改変は最小限 (単位換算・名寄せ・正規化) です。
        </p>
        <p className="text-sm text-on-surface-variant max-w-3xl mt-3">
          「このソースが抜けている」「この県はここに公開されている」という情報や、
          アダプタの実装そのものを歓迎しています —{' '}
          <Link href="/contribute" className="text-primary font-semibold hover:underline">
            開発者募集
          </Link>
          。
        </p>
      </div>

      {/* ===== 1. Sources ===== */}
      <section>
        <h2 className="text-xl font-semibold mb-3">1. 使用データソース</h2>
        <p className="text-sm text-on-surface-variant mb-4">
          優先度は同一ダムで複数ソースが値を持つときに採用するソースの並びです (大きい数字が優先)。
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th>ソース</th>
                <th>提供データ</th>
                <th>更新頻度</th>
                <th>ライセンス</th>
                <th className="text-right">優先度</th>
                <th className="text-right">直近30日</th>
                <th>最終取得</th>
              </tr>
            </thead>
            <tbody>
              {data.sources.map((s) => {
                const detail = SOURCE_DETAIL[s.source_id];
                const obs = data.obsBySource.get(s.source_id);
                return (
                  <tr key={s.source_id}>
                    <td>
                      <Link
                        href={`/sources/${encodeURIComponent(s.source_id)}`}
                        className="font-semibold hover:text-primary"
                      >
                        {s.source_id}
                      </Link>
                      {detail ? (
                        <div className="text-xs text-on-surface-variant max-w-xs">
                          {detail.upstream}
                        </div>
                      ) : null}
                    </td>
                    <td className="text-xs max-w-md">{detail?.what ?? s.description ?? '—'}</td>
                    <td className="text-xs">{detail?.cadence ?? '—'}</td>
                    <td className="text-xs">{detail?.license ?? '—'}</td>
                    <td className="text-right tabular-nums">{s.priority}</td>
                    <td className="text-right text-xs tabular-nums">
                      {obs ? (
                        <>
                          <div>{fmt(obs.rows_30d)} 件</div>
                          <div className="text-[10px] text-on-surface-variant">
                            {fmt(obs.distinct_dams_30d)} 基
                          </div>
                        </>
                      ) : (
                        <span className="text-on-surface-variant">—</span>
                      )}
                    </td>
                    <td className="text-xs text-on-surface-variant">
                      {obs?.latest_observed_at
                        ? fmtDate(obs.latest_observed_at)
                        : fmtDate(s.last_fetched_at)}
                      {s.last_status ? (
                        <span className="block text-[10px]">{s.last_status}</span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
              {Object.entries(SOURCE_DETAIL)
                .filter(([id]) => !data.sources.some((s) => s.source_id === id))
                .map(([id, d]) => (
                  <tr key={id} className="opacity-60">
                    <td>
                      <div className="font-semibold">{id}</div>
                      <div className="text-xs text-on-surface-variant max-w-xs">{d.upstream}</div>
                    </td>
                    <td className="text-xs max-w-md">{d.what}</td>
                    <td className="text-xs">{d.cadence}</td>
                    <td className="text-xs">{d.license}</td>
                    <td className="text-right tabular-nums text-on-surface-variant">—</td>
                    <td className="text-right text-xs text-on-surface-variant">—</td>
                    <td className="text-xs text-on-surface-variant">未取得</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ===== 2. Name matching ===== */}
      <section>
        <h2 className="text-xl font-semibold mb-3">2. ダム名寄せ (Damnet ↔ 国土数値情報)</h2>
        <p className="text-sm text-on-surface-variant mb-4 max-w-3xl">
          土台は国土数値情報 (NDI) の {fmt(c.total)} 行のダムマスタ。これに対しダム便覧 (Damnet) の
          2,600 件をぶつけて属性を埋めています。両者を結合する一意 ID は無いため、
          以下の手順でマッチさせています。
        </p>
        <ol className="list-decimal list-inside space-y-2 text-sm max-w-3xl">
          <li>
            <strong>名前の正規化</strong>:{' '}
            <code className="text-xs bg-surface-variant px-1 rounded">
              NFKC → 「（再）/（元）/（新）」剥離 → 「ダム/貯水池/池」接尾辞剥離 → 小文字化
            </code>
            。再開発前/後で別行になっている NDI 側のダム ({fmt(data.redevCount)} 件 該当) を 1
            つにまとめるための処理です。
          </li>
          <li>
            <strong>キー生成</strong>:{' '}
            <code className="text-xs bg-surface-variant px-1 rounded">
              prefCode | normalizeName(name)
            </code>
            。都道府県を必ず一致させることで、同名異所のダム (例: 同じ「中央ダム」が複数県に存在)
            の誤接続を防止。
          </li>
          <li>
            <strong>多対 1 マッチ</strong>: NDI 側に同キーが複数行ある場合 (再/元 のペアなど) は、
            Damnet ID は最初の 1 行にだけ付与し、属性 (有効貯水容量・諸元) はグループ全行に backfill
            します (Damnet の unique 制約に違反しないため)。
          </li>
          <li>
            <strong>属性の上書きルール</strong>:{' '}
            <code className="text-xs bg-surface-variant px-1 rounded">COALESCE(damnet, 既存)</code>
            。NDI が既に値を持つカラムは上書きせず、空欄だけ Damnet で埋めます。
            数値ソースの差分を抑えるためで、両ソースが矛盾するときは NDI が優先。
          </li>
          <li>
            <strong>slug 修復</strong>: 仮 slug (
            <code className="text-xs bg-surface-variant px-1 rounded">dam-NNN-PP</code>) のダムは
            Damnet から得た 読み仮名を slug 化して置き換えます (例:{' '}
            <code className="text-xs bg-surface-variant px-1 rounded">dam-716-14</code> →{' '}
            <code className="text-xs bg-surface-variant px-1 rounded">doushi-14</code>)。
          </li>
        </ol>
        <div className="mt-4 text-xs text-on-surface-variant max-w-3xl">
          実装:{' '}
          <code className="text-xs bg-surface-variant px-1 rounded">
            apps/web/bin/match_damnet.ts
          </code>{' '}
          / 検収レビュー待ちの曖昧マッチは{' '}
          <code className="text-xs bg-surface-variant px-1 rounded">match_review</code>{' '}
          テーブルに堆積。
        </div>

        <h3 className="text-sm font-semibold mt-6 mb-2">具体例</h3>
        <p className="text-xs text-on-surface-variant mb-3 max-w-3xl">
          実際のデータで遭遇したパターンと、それぞれを正規化ロジックがどう同じキーに落とし込んでいるかの例。
        </p>
        <div className="space-y-4 max-w-3xl text-sm">
          <Example
            tag="シンプルな接尾辞剥離"
            ndi="道志ダム"
            damnet="道志ダム"
            normalized="どうし"
            note="「ダム」を剥がして prefCode=14 (神奈川) と組み合わせて一致 (Damnet ID 0699)。有効貯水容量 616 千 m³ がそのまま流入。"
          />
          <Example
            tag="再開発バリアント (元/再 を統合)"
            ndi="佐久間（元）／佐久間（再）"
            damnet="佐久間ダム"
            normalized="さくま"
            note="NDI が再開発前後を別行で持つが Damnet は 1 件。両方に同じ有効貯水容量 (221.6 百万 m³) を backfill。Damnet ID は片方だけに付与。"
          />
          <Example
            tag="新しく作り直した dam"
            ndi="新桂沢（再）"
            damnet="新桂沢ダム"
            normalized="しんかつらざわ"
            note="「（再）」を剥離。新桂沢は元の桂沢ダムを嵩上げした再開発で、Damnet 上は別エントリ。"
          />
          <Example
            tag="NFKC 正規化 (全半角ゆれ)"
            ndi="夕張シューパロ（再）"
            damnet="夕張シューパロダム"
            normalized="ゆうばりしゅうぱろ"
            note="全角カタカナはそのまま、（再）剥離 + ダム剥離。pref=01 (北海道) で 1 件にマッチ。"
          />
          <Example
            tag="貯水池 / 池 の表記ゆれ"
            ndi="御大典池"
            damnet="御大典池"
            normalized="みのりがい"
            note="「池」「貯水池」もダムと同じ扱いで剥離。読み仮名「みのりがい」で slug を再生成。"
          />
          <Example
            tag="同名異所"
            ndi="中央ダム (北海道) / 中央ダム (福島県)"
            damnet="中央ダム × 2 件"
            normalized="ちゅうおう"
            note="名前のみだと衝突するが prefCode を必ずキーに含めるので誤接続しない (01 と 07 で別キー)。"
          />
          <Example
            tag="名前一致せず（マッチ失敗）"
            ndi="表沢堤"
            damnet="(該当なし)"
            normalized="おもてざわ-?"
            note="「堤」は接尾辞剥離対象外で、Damnet にも当該名なし。skippedNotFound として 有効貯水容量 NULL のまま残る。"
            failed
          />
          <Example
            tag="Damnet ID 衝突 (片方だけ採用)"
            ndi="鶴田（元） / 鶴田（再）"
            damnet="鶴田ダム"
            normalized="つるた"
            note="どちらも同じ Damnet 行を参照。external_ids.damnet=0XXX は最初の 1 行にだけ付与され、もう一方は skippedConflict としてスキップ (ただし有効貯水容量等の属性は両方に適用)。"
          />
        </div>
      </section>

      {/* ===== 3. ERD ===== */}
      <section>
        <h2 className="text-xl font-semibold mb-3">3. データ構造 (ER 図)</h2>
        <p className="text-sm text-on-surface-variant mb-4 max-w-3xl">
          中心は <strong>dams</strong> (マスタ) と <strong>observations</strong> (時系列)。
          外部の生データ (raw_snapshots) は監査用に S3 へ保管し、解析後の値だけを observations
          に書き戻す Lakehouse 風の構成です。
        </p>
        <div className="overflow-x-auto">
          <ErdSvg />
        </div>
        <p className="text-xs text-on-surface-variant mt-3">
          線種: 実線 = FK 結合 / 点線 = ソフトリンク (jsonb 経由)。観測テーブルは TimescaleDB の
          hypertable で時間方向に自動分割。
        </p>
      </section>

      {/* ===== 4. dams columns ===== */}
      <section>
        <h2 className="text-xl font-semibold mb-3">4. ダムマスタの主なカラム</h2>
        <p className="text-sm text-on-surface-variant mb-4 max-w-3xl">
          dams テーブルは {fmt(c.total)} 行。出処を併記しています。
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th>カラム</th>
                <th>意味</th>
                <th>主な出処</th>
                <th className="text-right">充足率</th>
              </tr>
            </thead>
            <tbody>
              <ColumnRow
                col="slug"
                desc="URL 断片 (例: doushi-14)。読み仮名+都道府県コードから生成。"
                src="自動生成"
                rate="100 %"
              />
              <ColumnRow col="name" desc="日本語ダム名" src="NDI" rate="100 %" />
              <ColumnRow
                col="name_kana"
                desc="読み仮名 (ひらがな)"
                src="Damnet"
                rate={pct(c.with_kana, c.total)}
              />
              <ColumnRow
                col="pref_code"
                desc="JIS 都道府県コード (01〜47)"
                src="NDI"
                rate="100 %"
              />
              <ColumnRow
                col="location"
                desc="緯度経度 (PostGIS geography Point, EPSG:4326)"
                src="NDI"
                rate="100 %"
              />
              <ColumnRow
                col="elevation_m"
                desc="標高 (メートル)。緯度経度を国土地理院 DEM API に問い合わせ。"
                src="国土地理院"
                rate="100 %"
              />
              <ColumnRow
                col="watershed_id"
                desc="一級 / 二級水系 ID (FK to watersheds)"
                src="NDI A21 + 空間結合"
                rate="100 %"
              />
              <ColumnRow
                col="manager"
                desc="管理者 (例: 国土交通省, 神奈川県企業庁)"
                src="NDI / Damnet"
                rate="79 %"
              />
              <ColumnRow
                col="type"
                desc="型式 (重力式コンクリート, アースフィル, ロックフィル …)"
                src="Damnet"
                rate="—"
              />
              <ColumnRow
                col="height_m"
                desc="堤高 (m)"
                src="NDI / Damnet"
                rate={pct(c.with_height, c.total)}
              />
              <ColumnRow col="total_capacity_m3" desc="総貯水容量" src="NDI" rate="100 %" />
              <ColumnRow
                col="active_capacity_m3"
                desc="有効貯水容量 = 貯水率の既定の分母として採用"
                src="Damnet"
                rate={pct(c.with_active, c.total)}
              />
              <ColumnRow
                col="effective_capacity_m3"
                desc="有効貯水容量 = 総貯水量 − 堆砂容量"
                src="Damnet (active と同値で mirror)"
                rate={pct(c.with_effective, c.total)}
              />
              <ColumnRow
                col="completed_year"
                desc="竣工年"
                src="NDI / Damnet"
                rate={pct(c.with_completed, c.total)}
              />
              <ColumnRow
                col="purposes"
                desc="目的コード (F=洪水調節, N=不特定, A=灌漑, W=上水, I=工業, P=発電, S=消流雪)"
                src="Damnet"
                rate={pct(c.with_purposes, c.total)}
              />
              <ColumnRow
                col="watershed_area_km2"
                desc="流域面積"
                src="Damnet"
                rate={pct(c.with_watershed_area, c.total)}
              />
              <ColumnRow
                col="image_url"
                desc="ダム写真 (Damnet 優先, Wikipedia フォールバック)"
                src="Damnet / Wikipedia"
                rate={pct(c.with_image, c.total)}
              />
              <ColumnRow
                col="external_ids"
                desc="ソース別の外部 ID (jsonb)"
                src="-"
                rate={`damnet ${pct(c.with_damnet, c.total)}`}
              />
            </tbody>
          </table>
        </div>
      </section>

      {/* ===== 5. Coverage gaps ===== */}
      <section>
        <h2 className="text-xl font-semibold mb-3">5. 欠損データの分布</h2>
        <p className="text-sm text-on-surface-variant mb-4 max-w-3xl">
          有効貯水容量を例に、容量帯ごとの欠落率を示します。大規模ダムほどカバレッジが高く、 10万 m³
          未満の小規模ダム (農業用ため池, 砂防ダム等) で Damnet 未収録が顕著です。
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm max-w-2xl">
            <thead>
              <tr>
                <th>容量帯</th>
                <th className="text-right">ダム数</th>
                <th className="text-right">欠落 (有効貯水容量)</th>
                <th className="text-right">欠落率</th>
              </tr>
            </thead>
            <tbody>
              {data.buckets.map((b) => (
                <tr key={b.bucket}>
                  <td>{b.bucket}</td>
                  <td className="text-right tabular-nums">{fmt(b.total)}</td>
                  <td className="text-right tabular-nums">{fmt(b.missing)}</td>
                  <td className="text-right tabular-nums">{pct(b.missing, b.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-on-surface-variant mt-3 max-w-3xl">
          欠落の主因: ① Damnet 未収録 (主に 10 万 m³ 未満の小規模ダム), ②
          名寄せできなかった同名・別字ゆれ (
          <code className="text-xs bg-surface-variant px-1 rounded">match_review</code>{' '}
          に堆積)。再開発バリアント (
          <code className="text-xs bg-surface-variant px-1 rounded">（再）/（元）</code>) は
          名寄せ時に統合済み。
        </p>
      </section>

      {/* ===== 6. Observation cadence ===== */}
      <section>
        <h2 className="text-xl font-semibold mb-3">6. 観測値の粒度</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
          <Stat label="観測対象ダム数" value={fmt(data.cadence.distinct_dams)} />
          <Stat label="観測総数" value={fmt(data.cadence.total)} />
          <Stat label="直近 24h" value={fmt(data.cadence.last_24h)} />
          <Stat
            label="期間"
            value={
              data.cadence.earliest && data.cadence.latest
                ? `${fmtDateOnly(data.cadence.earliest)} 〜 ${fmtDateOnly(data.cadence.latest)}`
                : '—'
            }
          />
        </div>
        <ul className="list-disc list-inside text-sm space-y-2 max-w-3xl">
          <li>
            <strong>原始粒度: 1 時間</strong>。過去データの定期バッチ取込時にこの粒度で保存します
            (リアルタイム監視ではありません)。
          </li>
          <li>
            <strong>カラム</strong>:{' '}
            <code className="text-xs bg-surface-variant px-1 rounded">
              storage_volume_m3, storage_rate, inflow_m3s, outflow_m3s, water_level_m, quality_flag
            </code>
            。欠落カラムは NULL (誤値の補間や想定値補完はしない)。
          </li>
          <li>
            <strong>集計</strong>: TimescaleDB の continuous aggregate で日次 (
            <code className="text-xs bg-surface-variant px-1 rounded">obs_daily</code>) と月次 (
            <code className="text-xs bg-surface-variant px-1 rounded">obs_monthly</code>)
            を自動更新。グラフ・統計はこの集計を読みます。
          </li>
          <li>
            <strong>retention</strong>: 原始データは無期限保持 (容量効率は Timescale の 列圧縮)。S3
            上の生スナップショット (raw_snapshots) も無期限。
          </li>
          <li>
            <strong>品質フラグ</strong>:{' '}
            <code className="text-xs bg-surface-variant px-1 rounded">quality_flag</code> で「正常 /
            推定 / 観測停止 / 異常値」を区別。利用者は
            <code className="text-xs bg-surface-variant px-1 rounded">quality_flag = 'ok'</code>{' '}
            のみで分析するのが安全。
          </li>
          <li className="text-amber-700">
            <strong>提供範囲</strong>: 本サービスは <strong>履歴データに特化</strong>{' '}
            しており、現在時刻の値 (リアルタイム) は再配信していません。最新値が必要な場合は{' '}
            <a
              href="https://www.river.go.jp/"
              target="_blank"
              rel="noreferrer noopener"
              className="text-primary hover:underline"
            >
              川の防災情報
            </a>{' '}
            などの一次情報源を併用してください。
          </li>
        </ul>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-outline-variant rounded-xl p-3 bg-white">
      <div className="text-xs text-on-surface-variant">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Example({
  tag,
  ndi,
  damnet,
  normalized,
  note,
  failed,
}: {
  tag: string;
  ndi: string;
  damnet: string;
  normalized: string;
  note: string;
  failed?: boolean;
}) {
  return (
    <div
      className={`border rounded-lg p-3 bg-white ${
        failed ? 'border-amber-400/70' : 'border-outline-variant'
      }`}
    >
      <div className="flex items-baseline gap-2 mb-2">
        <span
          className={`text-[10px] uppercase tracking-wide font-semibold px-2 py-0.5 rounded ${
            failed ? 'bg-amber-100 text-amber-900' : 'bg-primary/10 text-primary'
          }`}
        >
          {tag}
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
        <div>
          <div className="text-[10px] text-on-surface-variant uppercase">NDI 側</div>
          <code className="text-xs">{ndi}</code>
        </div>
        <div>
          <div className="text-[10px] text-on-surface-variant uppercase">Damnet 側</div>
          <code className="text-xs">{damnet}</code>
        </div>
        <div>
          <div className="text-[10px] text-on-surface-variant uppercase">正規化キー</div>
          <code className="text-xs">{normalized}</code>
        </div>
      </div>
      <p className="text-xs text-on-surface-variant mt-2">{note}</p>
    </div>
  );
}

function ColumnRow({
  col,
  desc,
  src,
  rate,
}: {
  col: string;
  desc: string;
  src: string;
  rate: string;
}) {
  return (
    <tr>
      <td>
        <code className="text-xs">{col}</code>
      </td>
      <td className="text-xs">{desc}</td>
      <td className="text-xs text-on-surface-variant">{src}</td>
      <td className="text-right text-xs tabular-nums">{rate}</td>
    </tr>
  );
}

/**
 * Compact ER diagram drawn with raw SVG so it works without extra deps.
 *
 * Layout coordinates use a 24px line-height inside boxes (titles take 44px).
 * The viewBox is generous to avoid label collisions; the wrapper makes the
 * SVG horizontally scrollable on narrow screens.
 */
function ErdSvg() {
  const W = 980;
  const H = 720;
  const LH = 18; // line height for body rows
  const HEAD = 44; // header height (title + subtitle + divider)

  // Helper to compute Y for the n-th body row (0-indexed)
  const row = (boxY: number, n: number) => boxY + HEAD + LH * (n + 1) - 4;

  // Box geometry
  const W_LEFT = 260;
  const X_LEFT = 30;
  const X_DAMS = 330;
  const W_DAMS = 300;
  const X_RIGHT = 670;
  const W_RIGHT = 280;

  // Watersheds (top-left)
  const WS_Y = 30;
  const WS_H = HEAD + LH * 4 + 10;
  // Rivers (mid-left)
  const RV_Y = WS_Y + WS_H + 30;
  const RV_H = HEAD + LH * 2 + 10;
  // match_review (bottom-left)
  const MR_Y = RV_Y + RV_H + 30;
  const MR_H = HEAD + LH * 4 + 10;

  // Dams (center, tall)
  const DM_Y = 30;
  const DM_LINES = 19;
  const DM_H = HEAD + LH * DM_LINES + 10;

  // Observations (top-right)
  const OB_Y = 30;
  const OB_H = HEAD + LH * 8 + 10;
  // Raw snapshots (mid-right)
  const RS_Y = OB_Y + OB_H + 30;
  const RS_H = HEAD + LH * 5 + 10;

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-labelledby="erd-title"
        className="border border-outline-variant rounded-xl bg-white"
        style={{ minWidth: 800 }}
      >
        <title id="erd-title">ER 図: dams を中心としたデータモデル</title>
        <defs>
          <marker
            id="arr"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            orient="auto"
          >
            <path d="M0,0 L10,5 L0,10 z" fill="#444" />
          </marker>
        </defs>

        <Box
          x={X_LEFT}
          y={WS_Y}
          w={W_LEFT}
          h={WS_H}
          title="watersheds"
          subtitle="水系 (一級/二級/その他)"
        >
          <BoxLine y={row(WS_Y, 0)}>id (PK)</BoxLine>
          <BoxLine y={row(WS_Y, 1)}>code, slug, name</BoxLine>
          <BoxLine y={row(WS_Y, 2)}>kind</BoxLine>
          <BoxLine y={row(WS_Y, 3)}>boundary (geog)</BoxLine>
        </Box>

        <Box x={X_LEFT} y={RV_Y} w={W_LEFT} h={RV_H} title="rivers" subtitle="河川">
          <BoxLine y={row(RV_Y, 0)}>id (PK)</BoxLine>
          <BoxLine y={row(RV_Y, 1)}>name, watershed_id (FK)</BoxLine>
        </Box>

        <Box x={X_LEFT} y={MR_Y} w={W_LEFT} h={MR_H} title="match_review" subtitle="名寄せ保留">
          <BoxLine y={row(MR_Y, 0)}>source_id + ext_id (PK)</BoxLine>
          <BoxLine y={row(MR_Y, 1)}>candidate_dam_ids[]</BoxLine>
          <BoxLine y={row(MR_Y, 2)}>best_dam_id, confidence</BoxLine>
          <BoxLine y={row(MR_Y, 3)}>resolved_dam_id, _at</BoxLine>
        </Box>

        <Box x={X_DAMS} y={DM_Y} w={W_DAMS} h={DM_H} title="dams" subtitle="ダムマスタ" highlight>
          <BoxLine y={row(DM_Y, 0)}>id (PK), slug</BoxLine>
          <BoxLine y={row(DM_Y, 1)}>name, name_kana</BoxLine>
          <BoxLine y={row(DM_Y, 2)}>pref_code (CHAR(2))</BoxLine>
          <BoxLine y={row(DM_Y, 3)}>watershed_id (FK)</BoxLine>
          <BoxLine y={row(DM_Y, 4)}>river_id (FK)</BoxLine>
          <BoxLine y={row(DM_Y, 5)}>location (geog Point)</BoxLine>
          <BoxLine y={row(DM_Y, 6)}>elevation_m</BoxLine>
          <BoxLine y={row(DM_Y, 7)}>type, manager, purposes</BoxLine>
          <BoxLine y={row(DM_Y, 8)}>height_m, crest_length_m</BoxLine>
          <BoxLine y={row(DM_Y, 9)}>total_capacity_m3</BoxLine>
          <BoxLine y={row(DM_Y, 10)}>active_capacity_m3</BoxLine>
          <BoxLine y={row(DM_Y, 11)}>effective_capacity_m3</BoxLine>
          <BoxLine y={row(DM_Y, 12)}>flood_capacity_m3</BoxLine>
          <BoxLine y={row(DM_Y, 13)}>watershed_area_km2</BoxLine>
          <BoxLine y={row(DM_Y, 14)}>reservoir_area_km2</BoxLine>
          <BoxLine y={row(DM_Y, 15)}>completed_year</BoxLine>
          <BoxLine y={row(DM_Y, 16)}>image_url</BoxLine>
          <BoxLine y={row(DM_Y, 17)}>external_ids (jsonb)</BoxLine>
          <BoxLine y={row(DM_Y, 18)}>created_at, updated_at</BoxLine>
        </Box>

        <Box
          x={X_RIGHT}
          y={OB_Y}
          w={W_RIGHT}
          h={OB_H}
          title="observations"
          subtitle="時系列 (TimescaleDB hypertable)"
          highlight
        >
          <BoxLine y={row(OB_Y, 0)}>dam_id (FK) + observed_at (PK)</BoxLine>
          <BoxLine y={row(OB_Y, 1)}>storage_volume_m3</BoxLine>
          <BoxLine y={row(OB_Y, 2)}>storage_rate</BoxLine>
          <BoxLine y={row(OB_Y, 3)}>inflow_m3s, outflow_m3s</BoxLine>
          <BoxLine y={row(OB_Y, 4)}>water_level_m</BoxLine>
          <BoxLine y={row(OB_Y, 5)}>quality_flag</BoxLine>
          <BoxLine y={row(OB_Y, 6)}>source_id, raw_snapshot_id (FK)</BoxLine>
          <BoxLine y={row(OB_Y, 7)} muted>
            cont. agg → obs_daily, obs_monthly
          </BoxLine>
        </Box>

        <Box
          x={X_RIGHT}
          y={RS_Y}
          w={W_RIGHT}
          h={RS_H}
          title="raw_snapshots"
          subtitle="生バイナリの監査ログ"
        >
          <BoxLine y={row(RS_Y, 0)}>id (PK), source_id, target_id</BoxLine>
          <BoxLine y={row(RS_Y, 1)}>fetched_at, http_status</BoxLine>
          <BoxLine y={row(RS_Y, 2)}>etag, storage_uri (s3://)</BoxLine>
          <BoxLine y={row(RS_Y, 3)}>bytes, content_type</BoxLine>
          <BoxLine y={row(RS_Y, 4)}>parse_status</BoxLine>
        </Box>

        {/* Edges (anchored to box edges, not interiors). */}
        {/* watersheds → dams */}
        <Edge x1={X_LEFT + W_LEFT} y1={WS_Y + 60} x2={X_DAMS} y2={DM_Y + 90} />
        {/* rivers → dams */}
        <Edge x1={X_LEFT + W_LEFT} y1={RV_Y + 50} x2={X_DAMS} y2={DM_Y + 110} />
        {/* watersheds → rivers (vertical) */}
        <Edge x1={X_LEFT + 60} y1={WS_Y + WS_H} x2={X_LEFT + 60} y2={RV_Y} />
        {/* match_review → dams (soft link) */}
        <Edge x1={X_LEFT + W_LEFT} y1={MR_Y + MR_H / 2} x2={X_DAMS} y2={DM_Y + DM_H - 60} dashed />
        {/* dams → observations */}
        <Edge x1={X_DAMS + W_DAMS} y1={DM_Y + 70} x2={X_RIGHT} y2={OB_Y + 70} />
        {/* observations → raw_snapshots (vertical) */}
        <Edge x1={X_RIGHT + 80} y1={OB_Y + OB_H} x2={X_RIGHT + 80} y2={RS_Y} />
      </svg>
    </div>
  );
}

function Box({
  x,
  y,
  w,
  h,
  title,
  subtitle,
  highlight,
  children,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  subtitle?: string;
  highlight?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={6}
        ry={6}
        fill={highlight ? '#eef4ff' : '#fff'}
        stroke={highlight ? '#3056e8' : '#9aa3b2'}
        strokeWidth={highlight ? 1.5 : 1}
      />
      <text x={x + 10} y={y + 18} fontSize={13} fontWeight="700" fill="#0e141b">
        {title}
      </text>
      {subtitle ? (
        <text x={x + 10} y={y + 32} fontSize={10} fill="#646464">
          {subtitle}
        </text>
      ) : null}
      <line x1={x} y1={y + 38} x2={x + w} y2={y + 38} stroke="#dfe3ea" />
      <g transform={`translate(${x + 10}, 0)`}>{children}</g>
    </g>
  );
}

function BoxLine({
  y,
  children,
  muted,
}: { y: number; children: React.ReactNode; muted?: boolean }) {
  return (
    <text
      y={y}
      fontSize={11}
      fill={muted ? '#646464' : '#0e141b'}
      fontStyle={muted ? 'italic' : undefined}
      style={{ fontFamily: 'ui-monospace, monospace' }}
    >
      {children}
    </text>
  );
}

function Edge({
  x1,
  y1,
  x2,
  y2,
  dashed,
}: { x1: number; y1: number; x2: number; y2: number; dashed?: boolean }) {
  return (
    <line
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      stroke="#444"
      strokeWidth={1.2}
      markerEnd="url(#arr)"
      strokeDasharray={dashed ? '4 3' : undefined}
    />
  );
}
