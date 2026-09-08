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
    upstream: '国土交通省 国土数値情報 (W01: ダム, W05: 河川, W07: 流域メッシュ)',
    license:
      'W01 / W05 / W07 はいずれも「非商用」(旧国土情報利用約款準拠版; W01 は有償刊行物を原典とするため商用利用不可): 出典・加工者を明示のうえ非商用目的で利用し、複製物は再配布しない。本サイトはこれらを加工して作成したダム属性・水系の区分 (一級/二級)・流域界を保持。',
    cadence: '年次 (毎年初旬に最新版へ差し替え)',
    what: 'マスタデータの土台。位置 (緯度経度), 都道府県, 河川, 流域, 総貯水容量, 堤高, 竣工年。水系の一級/二級区分 (W05 区間種別 + 水系域コード)。',
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
  'jwa-chikugo': {
    upstream: '水資源機構 筑後川ダム統合管理事務所 (water.go.jp/chikugo/chikugo/water-source.html)',
    license: '公的統計 — 出典明示で再配布可',
    cadence: '日次 (毎日 0:00 JST 値; 取得は 10:00 JST)',
    what: '筑後川水系 7 ダム (松原/下筌/大山/合所/江川/寺内/小石原川) の貯水率・貯水量。',
    label: 'JWA 筑後川',
  },
  'jwa-toneara': {
    upstream: '水資源機構 関東支社 (water.go.jp/honsya/honsya/suigen/sokuhou/toneara/index.html)',
    license: '公的統計 — 出典明示で再配布可',
    cadence: '日次 (毎日 0:00 JST 値; 取得は毎時 :39)',
    what: '利根川水系 9 施設 (矢木沢/奈良俣/藤原/相俣/薗原/八ッ場/下久保/草木/渡良瀬貯水池) と荒川水系 4 施設 (二瀬/滝沢/浦山/荒川貯水池) の貯水量(万m³)・貯水率。藤原/相俣/薗原/八ッ場/二瀬は新規カバレッジ。',
    label: 'JWA 利根川/荒川',
  },
  'jwa-toyokawa': {
    upstream: '水資源機構 中部支社 豊川水系 (water.go.jp/mizu/chubu/realtime/index_2.html)',
    license: '公的統計 — 出典明示で再配布可',
    cadence: '時次 (元データは ~10 分粒度; 取得は毎時 :43)',
    what: '豊川水系 2 ダム (宇連/大島) の貯水位(EL.m)・有効貯水量(m³)・流入量・放流量。リアルタイム観測; jwa-junpo (10 日) / aitoyo (日次) より高頻度。',
    label: 'JWA 豊川',
  },
  'jwa-yoshino': {
    upstream:
      '水資源機構 吉野川上流総合管理所 (water.go.jp/mizu/ikeda/mizuinfo/dyn/html/p0001/60/p000101.html)',
    license: '公的統計 — 出典明示で再配布可',
    cadence: '時次 (元データは 5 分粒度で自動更新; 取得は毎時 :45)',
    what: '吉野川水系 5 ダム (池田/早明浦/新宮/富郷/柳瀬) の貯水位(EL.m)・流入量・全放流量。早明浦ダムのみ利水貯水率[速報値]も提供 (四国の水不足予測の主要指標)。jwa-junpo (10 日) より高頻度で水位も追加。',
    label: 'JWA 吉野川',
  },
  'jwa-chubu': {
    upstream: '水資源機構 中部支社 (water.go.jp/mizu/chubu/report/)',
    license: '公的統計 — 出典明示で再配布可',
    cadence: '日次 (取得は毎時 :41)',
    what: '木曽川水系 6 ダム (牧尾/阿木川/味噌川/岩屋/中里/徳山) の貯水量(千m³)・貯水率・流入量・放流量。中里ダムは新規カバレッジ; 他 5 ダムは jwa-junpo より日次で詳細なデータを提供。',
    label: 'JWA 中部支社',
  },
  'jwa-kiso-rt': {
    upstream: '水資源機構 中部支社 木曽川水系 実時計 (water.go.jp/mizu/chubu/realtime/index.html)',
    license: '公的統計 — 出典明示で再配布可',
    cadence: '時次 (元データは ~10 分粒度; 取得は毎時 :47)',
    what: '木曽川水系 6 dams (牧尾/味噌川/阿木川/岩屋/徳山/中里貯水池) の貯水位(EL.m)・有効貯水量(千m³→m³)・流入量・放流量。jwa-chubu (日次, 優先度 296) を時次に格上げ。',
    label: 'JWA 木曽川 実時計',
  },
  'kanagawa-dam': {
    upstream: 'かながわの水がめ (kanagawa-dam.jp) — JSON API `summary.php`',
    license: '神奈川県企業庁 — 出典明示で再配布可 (推定)',
    cadence: '時次 (1 時間粒度; 取得は毎時 :05)',
    what: '神奈川県 5 ダム (相模/城山/三保/宮ヶ瀬/道志) の貯水位・貯水量・貯水率・流入量・放流量。',
    label: 'かながわの水がめ',
  },
  mudam: {
    upstream: 'NILIM ダム諸量データベース (mudam.nilim.go.jp)',
    license: '国の公式統計値 — 出典明示で再配布可 (robots.txt allows)',
    cadence: '日次 (1-2 年遅れの確定値; 1998-最新まで)',
    what: '全国 600 ダム × 日次 貯水位・流入量・放流量 (貯水量直接なし)。チャートの歴史的深さ補完用。',
    label: 'NILIM ダム諸量 DB',
  },
  'shiga-bousai': {
    upstream: '滋賀県土木防災情報システム (shiga-bousai.jp/dam)',
    license: '滋賀県オープンデータ — 出典明示で再配布可 (推定)',
    cadence: '時次 (1 時間粒度; 取得は毎時 :07)',
    what: '滋賀県 6 ダム (日野川/石田川/宇曽川/青土/姉川/永源寺) の貯水位・流入量・放流量・60分雨量。',
    label: '滋賀県土木防災',
  },
  'tottori-dam': {
    upstream: '鳥取県ダム諸量情報システム (tottoridam.jp)',
    license: '鳥取県オープンデータ — 出典明示で再配布可 (推定)',
    cadence: '時次 (1 時間粒度; ページは 10 分毎にリフレッシュ; 取得は毎時 :09)',
    what: '鳥取県 5 ダム (賀祥/朝鍋/佐治川/東郷/百谷) の貯水位・有効貯水量・貯水率・流入量・放流量・時間雨量。',
    label: '鳥取県ダム情報',
  },
  'aomori-dam': {
    upstream: '青森県砂防ダム情報 (kasensabo.bousai.pref.aomori.jp)',
    license: '青森県オープンデータ — 出典明示で再配布可 (推定)',
    cadence: '時次 (リアルタイム; 取得は毎時 :11)',
    what: '青森県 7 ダム (下湯/浅虫/久吉/遠部/浅瀬石川/津軽/清水目) の貯水位・流入量・全放流量。',
    label: '青森県砂防ダム',
  },
  'hkd-mlit-dam': {
    upstream: '国土交通省 北海道開発局 ダムリアルタイム情報 (info-dam.hdb.hkd.mlit.go.jp)',
    license: '国の公式統計値 — 出典明示で再配布可',
    cadence: '時次 (元データは 10 分粒度; 取得は毎時 :13)',
    what: '北海道開発局直轄 18 ダム (平取/忠別/豊平峡/岩尾内/漁川/定山渓/金山/鹿ノ子/新桂沢/二風谷/美利河/留萌/サンル/札内川/大雪/滝里/十勝/夕張シューパロ) の貯水位・流入量・放流量・貯水量・貯水率。',
    label: '北海道開発局ダム',
  },
  'chiba-suisei': {
    upstream: '千葉県 水政課 県内ダムの貯水状況 (pref.chiba.lg.jp/suisei/chosui)',
    license: '千葉県オープンデータ — 出典明示で再配布可 (推定)',
    cadence: '日次 (毎日 9:00 JST 値; 取得は 11:30 JST)',
    what: '千葉県内 23 ダム (水道用 20 + 工業用水 3) の貯水容量・貯水量(m³)・貯水率(%)。',
    label: '千葉県水政課',
  },
  'okayama-bousai': {
    upstream: 'おかやま防災ポータル (bousai.pref.okayama.jp)',
    license: '岡山県オープンデータ — 出典明示で再配布可 (推定)',
    cadence: '時次 (元データは 30 分粒度; 取得は毎時 :21)',
    what: '岡山県管理 ~15 ダム (旭川/鳴滝/河平/三室川/黒木/香々美/久賀/津川/黒谷/鬼ヶ岳/大佐/日笠/槙谷/楢井 ほか) の貯水位・有効貯水量・貯水率・流入量・全放流量。',
    label: 'おかやま防災ポータル',
  },
  'niigata-bousai': {
    upstream: '新潟県河川防災情報システム (doboku-bousai.pref.niigata.jp/kasen)',
    license: '新潟県オープンデータ — 出典明示で再配布可 (推定)',
    cadence: '時次 (元データは 10 分粒度; 取得は毎時 :23)',
    what: '新潟県管理 ~20 ダム (三面/奥三面/大谷/胎内川/奥胎内/早出川/破間川/笠堀/刈谷田川 ほか) の貯水位・貯水率・流入量・全放流量。',
    label: '新潟県河川防災情報',
  },
  'hyogo-bodik': {
    upstream: '兵庫県 ダム諸量データ (data.bodik.jp/dataset/280003_dam_hyogo)',
    license: 'CC-BY 4.0 — 出典明示で再配布可',
    cadence: '時次 (元データは 10 分粒度; 取得は毎時 :25)',
    what: '兵庫県管理 ~20 ダム (青野/生野/引原/安室/金出地/与布土/諭鶴羽 ほか) の貯水位・貯水量(m³)・全流入量・全放流量。BODIK オープンデータ CSV。',
    label: '兵庫県オープンデータ',
  },
  'tochigi-bodik': {
    upstream:
      '栃木県河川水位・雨量情報システム ダム諸量 (data.bodik.jp/dataset/090000_river_dam_parameter)',
    license: 'CC-BY 4.0 — 出典明示で再配布可',
    cadence: '時次 (元データは 10 分粒度; 取得は毎時 :27)',
    what: '栃木県管理 7 ダム (寺山/塩原/西荒川/東荒川/三河沢/中禅寺/松田川) の貯水位・貯水量(m³)・全流入量・全放流量。BODIK NGSI-v2 CSV。',
    label: '栃木県オープンデータ',
  },
  'osaka-bousai': {
    upstream: '大阪府河川防災情報 (osaka-kasen-portal.net/suibou/publicdata/choryuryo.json)',
    license: '公開情報 — 出典明示で再配布可',
    cadence: '時次 (元データは 1 分更新; 取得は毎時 :31)',
    what: '大阪府管理 3 ダム (安威川/箕面川/狭山池) の有効貯水量(m³)・貯水率。水位・流量は非公開。',
    label: '大阪府河川防災情報',
  },
  'hiroshima-bousai': {
    upstream: '広島県防災Web (bousai.pref.hiroshima.lg.jp/dam) — /data/dam/list/{ts}.json',
    license: '公開情報 — 出典明示で再配布可',
    cadence: '時次 (元データは 10 分粒度; 取得は毎時 :29)',
    what: '広島県管理 18 ダムの貯水位・有効貯水量(千m³)・全流入量・全放流量・貯水率。県管理 12 + 国管理 5 (cgr-mlit-dam と重複) + 農水省 1。',
    label: '広島県防災Web',
  },
  'tottori-bousai': {
    upstream: '鳥取県防災Web (bousai.pref.tottori.lg.jp/dam) — /data/dam/list/{ts}.json',
    license: '公開情報 — 出典明示で再配布可',
    cadence: '時次 (元データは 10 分粒度; 取得は毎時 :33)',
    what: '鳥取県管理 6 ダム (百谷/佐治川/東郷/賀祥/朝鍋/菅沢) の貯水位・有効貯水量(千m³)・全流入量・全放流量・貯水率。菅沢ダムは本ソース唯一の観測源。',
    label: '鳥取県防災Web',
  },
  'fukuoka-bodik': {
    upstream:
      '福岡市関連9ダム貯水量 — BODIK オープンデータ (data.bodik.jp/dataset/401307_mizukanri)',
    license: 'CC-BY 4.0 (出典明示で商用利用可)',
    cadence: '時次 (毎時更新; 取得は毎時 :35)',
    what: '福岡市水道局管理 9 ダム (南畑/五ケ山/脊振/曲渕/江川/久原/長谷/猪野/瑞梅寺) の有効貯水量(千m³)。水位・流量は非公開。',
    label: '福岡市関連ダム',
  },
  'shimane-bousai': {
    upstream: '島根県防災Web (bousai.pref.shimane.lg.jp/dam) — /data/dam/list/{ts}.json',
    license: '公開情報 — 出典明示で再配布可',
    cadence: '時次 (元データは 10 分粒度; 取得は毎時 :37)',
    what: '島根県土木部管理 14 ダム (布部/山佐/三瓶/波積/八戸/浜田/第二浜田/大長見/御部/益田川/笹倉/大峠/銚子/美田) の貯水位・有効貯水量(千m³)・全流入量・全放流量・貯水率。県直轄ダムの新規カバレッジ。',
    label: '島根県防災Web',
  },
  kasenbosai: {
    upstream: '国土交通省 川の防災情報 (river.go.jp) — tmlist/dam per-obs JSON',
    license: '国の公式統計値 — 出典明示で再配布可',
    cadence: '時次 (元データは 10 分粒度; 取得は毎時 :03)',
    what: '全国 ~870 ダムの 10 分粒度 貯水位・貯水量・有効容量貯水率・全流入量・全放流量。MLIT SCC の per-dam tmlist/dam/{obs_fcd}.json から取得。',
    label: '川の防災情報',
  },
  'hrr-mlit-dam': {
    upstream: '国土交通省 北陸地方整備局 ダム防災情報 (hrr.mlit.go.jp/river/dam-bousai)',
    license: '国の公式統計値 — 出典明示で再配布可',
    cadence: '時次 (元データは 10 分粒度; 取得は毎時 :19)',
    what: '北陸地方整備局直轄 7 ダム (福島:大川 / 山形:横川 / 新潟:大石・三国川 / 長野:大町 / 富山:宇奈月 / 石川:手取川) の貯水位・流入量・放流量。',
    label: '北陸地方整備局ダム',
  },
  'ktr-kinu-dam': {
    upstream:
      '国土交通省 関東地方整備局 鬼怒川ダム統合管理事務所 (ktr.mlit.go.jp/kinudamu/daminfo)',
    license: '国の公式統計値 — 出典明示で再配布可',
    cadence: '時次 (元データは 10 分粒度; 取得は毎時 :17)',
    what: '関東地方整備局 鬼怒川ダム統管直轄 4 ダム (栃木県: 五十里/川俣/川治/湯西川) の貯水位・全流入量・全放流量・累加雨量。',
    label: '鬼怒川ダム統管',
  },
  'cgr-mlit-dam': {
    upstream:
      '国土交通省 中国地方整備局 ダム防災情報システム (cgr.mlit.go.jp/cginfo/syokai/busyo/kasen/dam_bousai)',
    license: '国の公式統計値 — 出典明示で再配布可',
    cadence: '時次 (取得は毎時 :15)',
    what: '中国地方整備局直轄 11 ダム (岡山:苫田 / 広島:土師・弥栄・八田原・温井・灰塚 / 山口:島地川 / 鳥取:菅沢・殿 / 島根:志津見・尾原) の貯水位・流入量・放流量・貯水率(有効容量)・雨量。',
    label: '中国地方整備局ダム',
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
