// Editorial metadata about each registered data source. Lives outside the
// DB because it's content (license blurbs, upstream URLs) rather than
// behaviour — and the DB row only stores priority + active flag.
//
// Used by:
//   - /sources page (table)
//   - /sources/[id] page (detail)
//   - components/source-badge.tsx (label / link target)

export interface SourceDetail {
  /** Human-readable upstream source name + URL hint. */
  upstream: string;
  license: string;
  cadence: string;
  what: string;
  /** Friendly short label for badge / link text (defaults to source_id). */
  label?: string;
}

export const SOURCE_DETAILS: Record<string, SourceDetail> = {
  ndi: {
    upstream: '国土交通省 国土数値情報 (W01: 河川, W07: ダム, A21: 流域)',
    license: '出典明示で再配布可 (政府標準利用規約 2.0 互換)',
    cadence: '年次 (毎年初旬に最新版へ差し替え)',
    what: 'マスタデータの土台。位置 (緯度経度), 都道府県, 河川, 流域, 総貯水容量, 堤高, 竣工年。',
    label: '国土数値情報',
  },
  damnet: {
    upstream: '一般財団法人日本ダム協会「ダム便覧」 (dambinran.damnet.or.jp)',
    license: '個別データの引用・改変は出典明示で可。一括 DL は要相談。',
    cadence: '月 1 回 (master:refresh:damnet cron / 毎月 5 日 03:00 UTC)',
    what: '利水容量・有効貯水容量, 目的, 型式, 堤頂長, 流域面積, 湛水面積, 着工年, 事業者, 施工者, ダム湖名, 写真。',
    label: 'ダム便覧',
  },
  wikipedia: {
    upstream: 'ja.wikipedia.org REST API (pageimages prop)',
    license: 'CC-BY-SA 4.0 (各ページの著作者に従う)',
    cadence: '月 1 回 (images:refresh:wikipedia cron / 毎月 2 日 05:00 UTC)',
    what: 'Damnet に写真がない場合のフォールバック。記事サムネイル URL のみ。',
    label: 'Wikipedia',
  },
  gsi: {
    upstream: '国土地理院 標高 API (cyberjapandata.gsi.go.jp/general/dem)',
    license: '出典明示で利用可',
    cadence: '月 1 回 (master:refresh:elevation cron)',
    what: '地点標高 (DEM10B / 5A 統合)。緯度経度から数 m 精度で取得。',
    label: 'GSI',
  },
  'tokyo-waterworks': {
    upstream: '東京都水道局 水源情報 (waterworks.metro.tokyo.lg.jp/suigen/suigen.html)',
    license: '東京都オープンデータ (出典明示で再配布可)',
    cadence: '日次 (毎日 12:00 / 18:00 JST に取得)',
    what: '東京都の水源 15 ダム (利根川・荒川・多摩川 水系) の貯水量 (万m³) と貯水率 (%)。前日からの増減量。',
    label: '東京都水道局',
  },
  'jwa-junpo': {
    upstream: '水資源機構 旬報 (water.go.jp/honsya/honsya/suigen/junpo/index.html)',
    license: '統計法に基づく公的統計 (出典明示で再配布可)',
    cadence: '10 日毎 (毎月 1 / 11 / 21 日 JST 公表; 取得は日次でポーリング)',
    what: '水資源機構が管理する全国 26 ダムの利水容量・貯水量 (千m³)・貯水率 (現在 / 平年 / 平年比)。',
    label: '水資源機構 旬報',
  },
  aitoyo: {
    upstream: 'あいとよネット 公益財団法人 愛知・豊川用水振興協会 (aitoyo.or.jp)',
    license: '公益財団法人発行 — 出典明示で再配布可',
    cadence: '日次 (木曽川/豊川は 24:00 JST 値, 矢作川は 09:00 JST 値; 取得は 11:00 JST)',
    what: '木曽川 4 ダム (牧尾/阿木川/味噌川/岩屋), 豊川 1 ダム (宇連), 矢作川 2 ダム (矢作/羽布) の 利水容量・貯水量・貯水率・前日差・平年貯水率。',
    label: 'あいとよネット',
  },
  synthetic: {
    upstream: '当サイトの内部生成 (シード値)',
    license: 'CC0 (出典明示は任意)',
    cadence: '不変 (一括投入後の更新なし)',
    what: '上流フィードが未接続のダム向けにグラフ表示用の補完値を生成。実観測値ではない旨を UI で明示。',
    label: '推定値',
  },
};

/** Friendly label preferring SOURCE_DETAILS.label, falling back to source_id. */
export function sourceLabel(sourceId: string): string {
  return SOURCE_DETAILS[sourceId]?.label ?? sourceId;
}
