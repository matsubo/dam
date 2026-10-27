// One declaration per source (docs/adr/0001). Kept in id order; the comment
// above an entry explains its schedule and anything unusual about the feed.
// All crons are UTC (graphile-worker takes no timezone).

import { defineSource, type SourceDeclaration } from './source_declaration.ts';

// jwa-chubu, jwa-kiso-rt and jwa-toyokawa all read pages of the 中部支社
// リアルタイム情報 system (water.go.jp/mizu/chubu/), whose note asks users not to
// collect with tools. They are kept because the organisation-wide rule puts
// numeric data outside copyright; each entry adds how its fetch rate is kept
// low. Quotes verified against both documents on 2026-09-28.
const JWA_CHUBU_TERMS =
  '水資源機構「著作権・リンク等について」(water.go.jp/honsya/honsya/policy/copyright/): 「数値データ、簡単な表・グラフ等は著作権の対象ではありませんので、これらについては本利用ルールの適用はなく、自由に利用できます。」 中部支社 リアルタイム情報「ご利用上の注意事項」(water.go.jp/mizu/chubu/res/description/description.pdf): 「ツール等による、自動的なデータ収集等はサーバに負荷がかかり、情報提供できなくなる恐れがありますのでご遠慮頂くよう、ご理解・ご協力をお願いいたします。」「このサイトを営利目的に利用することはできません。私的使用又は引用等の著作権法上認められた行為を除き、機構に無断で転載、複製、出版、放送、上映等を行うことはできません。」 本サイトは観測値 (数値データ) のみを出典明示のうえ保持し、ページの文章・図表は複製しない。';

export const SOURCES: readonly SourceDeclaration[] = [
  // 愛知県 川の防災情報 ダム表 — 2 県管理ダム (雨山/木瀬). UTF-8 HTML; 10分更新.
  // Stores 24h of 10-min data per fetch. Cron at :12 every hour.
  defineSource({
    id: 'aichi-kasen',
    priority: 308,
    description: '愛知県川の防災情報 ダム表 — 2 ダム (UTF-8 HTML, 10分更新)',
    ingestCron: '12 * * * *',
    details: {
      label: '愛知県 川の防災情報',
      upstream: '愛知県 川の防災情報 ダム表 (www.kasen-aichi.jp/DamHis_10_0_1.html)',
      license: null,
      cadence: '10分更新 (毎時 :12 に取得; 1 回で直近 24 時間分の 10 分値を保存)',
      what: '愛知県管理 2 ダム (雨山/木瀬) の貯水位・貯水量 (千m³→m³)・流入量・放流量。「**」(欠測) / 「--」(未収集) は欠損として扱う。',
    },
  }),
  // あいとよネット (aitoyo) — 7 dams across 木曽川 / 豊川 / 矢作川 系. The page
  // shows ONE day (24:00 JST 木曽川/豊川, 09:00 JST 矢作川 values), replaced on
  // business days at a varying hour, often after 11:00 JST; a once-a-day poll
  // missed 9/27's (up by 12:57 JST 9/28, not at the 11:00 run). Hourly
  // 09:15–20:15 JST; the upsert on the reading time makes repeats free.
  defineSource({
    id: 'aitoyo',
    priority: 295,
    description:
      'あいとよネット (公益財団法人 愛知・豊川用水振興協会) — daily, 7 dams in 木曽川/豊川/矢作川 系',
    trustedRateBasis: true,
    ingestCron: '15 0-11 * * *',
    // Business-day page: Friday's shows Thursday 24:00, the next is Monday's
    // (Sunday 24:00, often after 11:00 JST) — ~85 h; a Monday holiday adds a
    // day. The derived threshold (3 × the ~72 h weekend gap) would be ~10 d.
    freshnessOverrideHours: 5 * 24,
    details: {
      upstream: 'あいとよネット 公益財団法人 愛知・豊川用水振興協会 (aitoyo.or.jp)',
      license: '公益財団法人発行 — 出典明示で再配布可',
      cadence:
        '営業日ごとの日次 (木曽川/豊川は当日 24:00 JST 値, 矢作川は当日 09:00 JST 値; 更新時刻が一定しないため 09:15–20:15 JST に毎時取得)',
      what: '木曽川 4 ダム (牧尾/阿木川/味噌川/岩屋), 豊川 1 ダム (宇連), 矢作川 2 ダム (矢作/羽布) の 利水容量・貯水量・貯水率・前日差・平年貯水率。',
      label: 'あいとよネット',
    },
  }),
  // 秋田県河川砂防情報システム ダム一覧表 — 18 県管理ダム (防災Web HTML table, Shift_JIS,
  // no session). 12 columns: level / inflow / outflow (no storage volume).
  // Cron at :01.
  defineSource({
    id: 'akita-kasen',
    priority: 308,
    description: '秋田県ダム一覧表 — 防災Web HTML table, 18 dams, hourly',
    ingestCron: '1 * * * *',
    details: {
      label: '秋田県 河川砂防情報',
      upstream:
        '秋田県河川砂防情報システム 防災Web ダム一覧表 (kasen.pref.akita.lg.jp/pc/servlet/bousaiweb.servletBousaiTableStatus?sv=3&dk=4&mp=0&no=0&fn=0&pg=1)',
      license: null,
      cadence: '時次 (取得は毎時 :01)',
      what: '秋田県管理 18 ダム (森吉/素波里/鎧畑/玉川/皆瀬 ほか; 八郎潟防潮水門は除外) の貯水位 (EL.m)・流入量・放流量。表に貯水量・貯水率の列はなく、時間雨量・累加雨量は保存しない。',
    },
  }),
  // 青森県河川砂防情報提供システム — every dam on the ダム諸量現況表 (11),
  // one ダム諸量グラフ (10分) page each; stores the latest row. Cron at :11.
  defineSource({
    id: 'aomori-dam',
    priority: 306,
    description:
      '青森県河川砂防情報提供システム ダム諸量グラフ — hourly, ダム諸量現況表の全ダム (11: 下湯/久吉/浅瀬石川/世増/浅虫/遠部/津軽/飯詰/小泊/清水目/川内)',
    trustedRateBasis: true,
    ingestCron: '11 * * * *',
    // Hourly real-time sources — flag if older than 3 h.
    freshnessOverrideHours: 3,
    details: {
      upstream: '青森県河川砂防情報提供システム ダム諸量グラフ (kasensabo.bousai.pref.aomori.jp)',
      license: '青森県オープンデータ — 出典明示で再配布可 (推定)',
      cadence: '時次 (元データは 10 分粒度; 取得は毎時 :11)',
      what: '青森県河川砂防情報提供システムのダム諸量現況表に載る全ダム (11: 下湯/久吉/浅瀬石川/世増/浅虫/遠部/津軽/飯詰/小泊/清水目/川内) の貯水位・流入量・全放流量・貯水量 (有効容量)・貯水率 (利水容量; 利水容量のない遠部/清水目は有効容量)。',
      label: '青森県砂防ダム',
    },
  }),
  // 淡路広域水道企業団 各水源地の貯水状況 — 淡路島の水道ダム (猪鼻第１/第２/竹原/
  // 天川第１/第２/成相・北富士/牛内/本庄川), 貯水量 on a 現在 date, hand-edited
  // about monthly. Priority 288. Daily at 03:17 UTC (12:17 JST).
  defineSource({
    id: 'awaji-suido',
    priority: 288,
    description: '淡路広域水道企業団 各水源地の貯水状況 — 淡路島の水道ダム (月次程度 HTML)',
    ingestCron: '17 3 * * *',
    // Hand-edited about monthly; the index shows gaps up to 62 days (2026/3/26
    // → 5/27), and the 現在 date runs ~5 days behind the edit.
    freshnessOverrideHours: 70 * 24,
    details: {
      upstream: '淡路広域水道企業団「各水源地の貯水状況」 (www.awaji-suido.jp/osirase-01.html)',
      license:
        '利用条件の記載なし (robots.txt なし; フッターは「Copyright（C）2005 淡路広域水道企業団 All Rights Reserved.」) — 出典明示で観測値 (事実) のみを引用',
      cadence:
        '月 1 回程度 (手動更新; 日付のみ・時刻非公表のため 00:00 JST で記録; 取得は毎日 12:17 JST)',
      what: '淡路広域水道企業団の水源ダムの貯水量(m³)。猪ノ鼻/猪鼻第2/竹原/天川第2/本庄川を取り込み。貯水率は企業団独自の容量 (本庄川・牛内は利水分) 基準のため保存せず、貯水量から算出。天川第2 の貯水量は総貯水容量 (112 千m³) 基準の全量のため、最低水位以下の 59 千m³ (総 − 有効) を差し引いた有効分を保存。牛内は他ソースで毎時取得済み。天川第1 は台帳になく、成相・北富士は合算値のため未紐付け。',
      label: '淡路広域水道企業団',
    },
  }),
  // 国土交通省 中国地方整備局 福山河川国道事務所 — 芦田川河口堰 (芦田川水系, 広島/34).
  // mobile_ashidagawa/sekisyoryou.php, one 10分更新 snapshot: 堰上水位 + 貯水量(千m³)
  // + 流入量 + 放流量 (no rate). Priority 303. Cron at :02.
  defineSource({
    id: 'cgr-ashida-seki',
    priority: 303,
    description:
      '国土交通省 中国地方整備局 福山河川国道事務所 — 芦田川河口堰 (芦田川水系, 10分更新 HTML)',
    ingestCron: '2 * * * *',
    details: {
      upstream:
        '国土交通省 中国地方整備局 福山河川国道事務所「芦田川水系 水文データ」 (cgr.mlit.go.jp/fukuyama/mobile_ashidagawa/sekisyoryou.php)',
      license:
        '中国地方整備局ホームページのコンテンツは、権利表記の記載がない限り「公共データ利用規約（第1.0版）」(PDL1.0) に準拠した利用条件の下で利用可 — 出典記載が必要 (cgr.mlit.go.jp/about_manual)',
      cadence: '時次 (元データは 10 分更新の最新値のみ; 取得は毎時 :02)',
      what: '芦田川河口堰 (広島県福山市) の堰上水位・貯水量(千m³)・流入量・放流量。貯水率は非公表 (貯水量と有効貯水容量から算出)。',
      label: '芦田川河口堰',
    },
  }),
  // 国土交通省 中国地方整備局 — 11 国管理 dams across 5 prefectures
  // (岡山/広島/山口/鳥取/島根). Single POST JSON gives all dams' current
  // values. Cron at :15 every hour.
  defineSource({
    id: 'cgr-mlit-dam',
    priority: 304,
    description:
      '国土交通省 中国地方整備局 ダム防災情報システム — hourly, 11 dams (苫田/土師/弥栄/八田原/温井/灰塚/島地川/菅沢/殿/志津見/尾原)',
    ingestCron: '15 * * * *',
    // Hourly real-time sources — flag if older than 3 h.
    freshnessOverrideHours: 3,
    details: {
      upstream:
        '国土交通省 中国地方整備局 ダム防災情報システム (cgr.mlit.go.jp/cginfo/syokai/busyo/kasen/dam_bousai)',
      license: '国の公式統計値 — 出典明示で再配布可',
      cadence: '時次 (取得は毎時 :15)',
      what: '中国地方整備局直轄 11 ダム (岡山:苫田 / 広島:土師・弥栄・八田原・温井・灰塚 / 山口:島地川 / 鳥取:菅沢・殿 / 島根:志津見・尾原) の貯水位・流入量・放流量・貯水率(有効容量)・雨量。',
      label: '中国地方整備局ダム',
    },
  }),
  // 国土交通省 岡山河川事務所「三水系の主要ダムの貯水状況」— 吉井川・旭川・高梁川の
  // 11 ダム + 2 堰 (PDF, 平日 9時 速報値, ~09:45 JST 掲載)。小阪部川ダム・坂根堰は
  // ここにしか無い。10:50 / 14:50 JST に取得 (2 回目は遅れた掲載用)。PDF 内の
  // タイムスタンプへの冪等 UPSERT。
  defineSource({
    id: 'cgr-okakawa-dam',
    priority: 292,
    description:
      '国土交通省 中国地方整備局 岡山河川事務所 三水系主要ダム貯水状況 — 11 ダム + 2 堰, 平日 9時 (PDF)',
    ingestCron: '50 1,5 * * *',
    details: {
      upstream:
        '国土交通省 中国地方整備局 岡山河川事務所 三水系の主要ダムの貯水状況 (cgr.mlit.go.jp/okakawa/kouhou/kassui)',
      license: '公共データ利用規約（第1.0版） (PDL1.0) — 出典明示で再配布可',
      cadence: '日次 (平日 午前9時 速報値; 取得は 10:50 / 14:50 JST)',
      what: '吉井川・旭川・高梁川の主要 11 ダム + 2 堰 (小阪部川/坂根堰/新田原井堰/苫田/湯原/旭川/千屋/河本/新成羽川 ほか) の貯水量(千m³)・貯水率(洪水期利水容量比)。',
      label: '岡山河川事務所',
    },
  }),
  // 千葉県 農林水産部 耕地課「県内農業用ダム貯水状況」— 農業用ダム 11 基
  // (金山/安房中央/勝浦/荒木根/三島/戸面原/小中/佐久間/平沢/山内、保台のみ既ライブ)。
  // HTML 1 テーブル、有効貯水量・現貯水量・貯水率。調査日ベース (掲載は数日遅れる)
  // なので、他の農林ソースと同じく日次ポーリングで調査日タイムスタンプへ冪等 UPSERT。
  // #29 の一巡調査で net-new が最大だった県。
  defineSource({
    id: 'chiba-nourin',
    priority: 284,
    description:
      '千葉県 農林水産部 耕地課 県内農業用ダム貯水状況 — 農業用ダム 11 基 (貯水量+貯水率)',
    trustedRateBasis: true,
    ingestCron: '5 5 * * *',
    details: {
      label: '千葉県 農業用ダム',
      upstream:
        '千葉県 農林水産部 耕地課「県内農業用ダム貯水状況」 (www.pref.chiba.lg.jp/kouchi/nougyou-dam.html)',
      license: null,
      cadence:
        '調査日ベース (見出しの「令和N年M月D日 09時現在」; 掲載は数日遅れる; 取得は毎日 05:05 UTC)',
      what: '千葉県の農業用ダム 11 基 (金山/安房中央/勝浦/荒木根/三島/戸面原/小中/佐久間/平沢/山内/保台) の現有効貯水量 (m³) と貯水率 (%)。ページは m³ 表記のため単位換算なし; 末尾の計行は取り込まない。',
    },
  }),
  // 千葉県 県内ダムの貯水状況 — 23 dams (水道用+工業用水). Weekly 9 JST survey
  // (Mondays, 更新日 ~1 day later). Polled daily at 02:30 UTC = 11:30 JST.
  defineSource({
    id: 'chiba-suisei',
    priority: 290,
    description: '千葉県 県内ダムの貯水状況 — weekly 09:00 JST survey (23 ダム; 水道用+工業用水)',
    ingestCron: '30 2 * * *',
    // Weekly survey that can skip a week (9/14 was still the latest on 9/27),
    // plus a day or two before the page's 更新日.
    freshnessOverrideHours: 17 * 24,
    details: {
      upstream: '千葉県 水政課 県内ダムの貯水状況 (pref.chiba.lg.jp/suisei/chosui)',
      license: '千葉県オープンデータ — 出典明示で再配布可 (推定)',
      cadence: '週次 (月曜 9:00 JST 値、1 週飛ぶこともある; 取得は毎日 11:30 JST)',
      what: '千葉県内 23 ダム (水道用 20 + 工業用水 3) の貯水容量・貯水量(m³)・貯水率(%)。',
      label: '千葉県水政課',
    },
  }),
  // 大日川土地改良区 大日川ダム情報 — 大日川ダム (南あわじ市, NDI 1594). dam.html links
  // one 日別ダム情報 PDF per month; each line is 「各日午前９時測定」 水位 (a depth gauge,
  // not stored) + 貯水量(万t) + 貯水率 against the printed 最大貯水量 191.5万t. The
  // current and previous month are re-read every run (weekend rows land with
  // Monday's upload). Priority 278. Daily at 03:33 UTC (12:33 JST).
  defineSource({
    id: 'dainichigawa-lid',
    priority: 278,
    description: '大日川土地改良区 大日川ダム情報 — 大日川ダム (日別 PDF, 午前9時)',
    trustedRateBasis: true,
    ingestCron: '33 3 * * *',
    details: {
      upstream:
        '大日川土地改良区「大日川ダム情報」 (dainichigawa-lid.com/dam.html の月別「日別ダム情報」PDF)',
      license:
        '利用条件の記載なし (robots.txt なし; フッターは「© 2023 大日川土地改良区-Dainichigawa Land Improvement District-」) — 出典明示で観測値 (事実) のみを引用',
      cadence:
        '日次 (各日午前9時測定; 週末分は翌営業日にまとめて掲載; 取得は毎日 12:33 JST で当月・前月の PDF を再読)',
      what: '大日川ダム (兵庫県南あわじ市) の貯水量(万t)・貯水率 (最大貯水量 191.5万t 比)。水位は EL ではない水位計の読み (最大 29.4 m) のため保存しない。本ソース唯一の観測源。',
      label: '大日川土地改良区',
    },
  }),
  defineSource({
    id: 'damnet',
    priority: 50,
    description: 'ダム便覧 (master attributes)',
    providesObservations: false,
    jobs: [{ cron: '0 3 5 * *', task: 'master:refresh:damnet' }],
    details: {
      upstream: '一般財団法人日本ダム協会「ダム便覧」 (dambinran.damnet.or.jp)',
      license:
        'サイト表記は「『ダム便覧』内の文章、画像、データなどすべての内容の無断転載を禁じます」。出典明示による一括再利用を認める記載は確認できず、諸元は同協会の有償刊行物「ダム年鑑」由来。写真は 2026-09-10 に利用停止 (media-policy が写真ごとの使用条件または個別問い合わせを求めており、著作権も撮影者に帰属するため)。',
      cadence: '月 1 回 (master:refresh:damnet cron / 毎月 5 日 03:00 UTC)',
      what: '総貯水容量・有効貯水容量, 目的, 型式, 堤頂長, 流域面積, 湛水面積, 着工年, 事業者, 施工者, ダム湖名。利水容量は公表されていない。',
      label: 'ダム便覧',
    },
  }),
  // 愛媛県 河川砂防総合情報システム ダム諸量現況表 — 県管理ダム (防災Web HTML, Shift_JIS).
  // URL: kasen.pref.ehime.jp (geo-blocked outside Japan; works from production).
  // National dams (野村/鹿野川 via skr-hiji, 富郷/柳瀬 via jwa-yoshino) already covered.
  // Cron at :57.
  defineSource({
    id: 'ehime-bousai',
    priority: 308,
    description:
      '愛媛県河川・砂防情報システム ダム諸量経過表 — 12 dams (6 pref + 6 national), hourly',
    ingestCron: '57 * * * *',
    details: {
      label: '愛媛県 河川・砂防情報',
      upstream:
        '愛媛県 河川・砂防情報システム ダム諸量経過表 (183.176.244.72/kawabou-mng/customizeMyMenuKeika.do)',
      license: null,
      cadence: '時次 (ダムごとの 24 時間分の 1 時間値表から最新値; 取得は毎時 :57)',
      what: '愛媛県管理 6 ダム (鹿森/黒瀬/玉川/台/須賀川/山財) と国管理 6 ダム (柳瀬/石手川/鹿野川/野村/新宮/富郷) の貯水位・流入量・放流量・貯水量(千m³→m³)・貯水率。国管理ダムは貯水率が「-」(非公表) のことがある。',
    },
  }),
  // 福井県 河川・砂防総合情報システム ダム諸量現況表 — 13 ダム (防災Web Shift_JIS, hourly).
  // 永平寺/二ツ屋/浄土寺川/龍ヶ鼻/笹生川/桝谷/広野/河内川/大津呂/開谷/滝波 + 真名川/九頭竜(KKR).
  // Priority 308 upgrades kkr-mlit-dam (daily, priority 302) for 真名川/九頭竜.
  // Cron at :14 every hour.
  defineSource({
    id: 'fukui-bousai',
    priority: 308,
    description:
      '福井県河川・砂防総合情報システム ダム諸量現況表 — 13 ダム (Shift_JIS HTML, hourly)',
    trustedRateBasis: true,
    ingestCron: '14 * * * *',
    details: {
      label: '福井県 河川・砂防総合情報',
      upstream:
        '福井県 河川・砂防総合情報システム ダム諸量現況表 (sabo.pref.fukui.lg.jp/bousai/servlet/bousaiweb.servletBousaiTableStatus?dk=4)',
      license: null,
      cadence: '時次 (取得は毎時 :14)',
      what: '福井県の 13 ダム (県管理 11: 永平寺/二ツ屋/浄土寺川/龍ヶ鼻/笹生川/桝谷/広野/河内川/大津呂/開谷/滝波 + 近畿地方整備局管理の真名川/九頭竜) の貯水率 (利水容量)・貯水位・有効貯水量 (千m³)・流入量・放流量。真名川/九頭竜は kkr-mlit-dam (日次) を時次に格上げ。',
    },
  }),
  // 福岡市関連9ダム — BODIK open data (CC-BY), hourly Shift-JIS CSV.
  // Storage in 千m³ (南畑/五ケ山/脊振/曲渕/江川/久原/長谷/猪野/瑞梅寺).
  // Cron at :35.
  defineSource({
    id: 'fukuoka-bodik',
    priority: 310,
    description: '福岡市関連9ダム — BODIK CC-BY, hourly CSV (Shift-JIS, 千m³)',
    ingestCron: '35 * * * *',
    details: {
      upstream:
        '福岡市関連9ダム貯水量 — BODIK オープンデータ (data.bodik.jp/dataset/401307_mizukanri)',
      license: 'CC-BY 4.0 (出典明示で商用利用可)',
      cadence: '時次 (毎時更新; 取得は毎時 :35)',
      what: '福岡市水道局管理 9 ダム (南畑/五ケ山/脊振/曲渕/江川/久原/長谷/猪野/瑞梅寺) の有効貯水量(千m³)。水位・流量は非公開。',
      label: '福岡市関連ダム',
    },
  }),
  // 福島県河川流域総合情報システム — 11 県管理ダム (こまち/千五沢/堀川/真野/木戸/
  // 小玉/高柴/四時/日中/東山/田島). JST-dated JSON URL; item_10=貯水位 /
  // item_50=流入量 / item_70=放流量 / item_1_70=時間雨量 (no storage volume).
  // Same framework as 石川県河川総合情報システム. Cron at :34.
  defineSource({
    id: 'fukushima-kasen',
    priority: 308,
    description: '福島県河川流域総合情報システム — 11 県管理ダム hourly JSON',
    ingestCron: '34 * * * *',
    details: {
      label: '福島県 河川流域情報',
      upstream:
        '福島県河川流域総合情報システム (kaseninf.pref.fukushima.jp/dyn/json/dat/pc) — /{YYYYMMDD}/{YYYYMMDD}_1_dam_60.json',
      license: null,
      cadence: '時次 (JST 日付の JSON を毎時再生成; 取得は毎時 :34)',
      what: '福島県管理 11 ダム (こまち/千五沢/堀川/真野/木戸/小玉/高柴/四時/日中/東山/田島) の貯水位・全流入量・全放流量・時間雨量。貯水量・貯水率は非公開。',
    },
  }),
  // 福島県 農林水産部 県内の主要農業関係ダムの貯水状況 — 農業用ダム 29 基
  // (岳/藤倉/山ノ入/三ツ森/深田調整池/金沢調整池 ほか)。土木部の
  // ingest:fukushima-kasen とは対象ダムが重ならない。HTML 1 テーブル、
  // 貯水率（かんがい用水）のみ。調査日ベースで隔週更新なので、jwa-junpo と同じく
  // 日次ポーリング (報告日タイムスタンプへの冪等 UPSERT) で拾う。
  defineSource({
    id: 'fukushima-nourin',
    priority: 285,
    description:
      '福島県 農林水産部 県内の主要農業関係ダムの貯水状況 — 農業用ダム 29 基, 隔週 (貯水率のみ)',
    trustedRateBasis: true,
    ingestCron: '15 4 * * *',
    // Survey-date source: 福島県 publishes 隔週 in かんがい期 but only monthly
    // Oct–Mar, so the window has to clear a full winter gap plus publish lag.
    freshnessOverrideHours: 45 * 24,
    details: {
      upstream:
        '福島県 農林水産部 農地管理課「県内の主要農業関係ダムの貯水状況」 (pref.fukushima.lg.jp/sec/36045d/noutikannri010.html)',
      license: '公開情報 — 出典明示で再配布可',
      cadence: '隔週程度 (調査日 (令和N年M月D日現在) ベース; 取得は日次でポーリング)',
      what: '福島県内の農業関係ダム 29 基の貯水率 (かんがい用水分) と平年比。県土木部の河川ダムには載らない土地改良区・市町村管理の農業用ダム / 調整池 / 溜池が対象。貯水量・水位は非公開。',
      label: '福島県 農業関係ダム',
    },
  }),
  // 岐阜県 川の防災情報 ダム諸量 — 14 ダム (UTF-8 HTML, hourly).
  // 阿多岐/大ヶ洞/岩村/中野方/丹生川/矢作/小里川/横山/徳山/丸山/阿木川/岩屋/牧尾/味噌川.
  // Priority 308 upgrades overlapping jwa-chubu/aitoyo dams from daily to hourly.
  // Cron at :10 every hour.
  defineSource({
    id: 'gifu-kasen',
    priority: 308,
    description: '岐阜県川の防災情報 ダム諸量 — 14 ダム (UTF-8 HTML, hourly)',
    ingestCron: '10 * * * *',
    details: {
      label: '岐阜県 川の防災情報',
      upstream: '岐阜県 川の防災情報 ダム諸量 (www.kasen.pref.gifu.lg.jp/h/Dam.html)',
      license: null,
      cadence: '時次 (全ダム共通の「YYYY/MM/DD HH:MM現在」; 取得は毎時 :10)',
      what: '岐阜県 川の防災情報に載る 14 ダム (阿多岐/大ヶ洞/岩村/中野方/丹生川/矢作/小里川/横山/徳山/丸山/阿木川/岩屋/牧尾/味噌川) の貯水量 (千m³→m³)・全流入量・放流量。jwa-chubu / aitoyo と重なるダムを日次から時次に格上げ。',
    },
  }),
  defineSource({
    id: 'gsi',
    priority: 0,
    description: '国土地理院 標高 API — ダム地点の標高',
    providesObservations: false,
    jobs: [{ cron: '0 5 3 * *', task: 'master:refresh:elevation' }],
    details: {
      upstream: '国土地理院 標高 API (cyberjapandata.gsi.go.jp/general/dem)',
      license: '出典明示で利用可',
      cadence: '月 1 回 (master:refresh:elevation cron)',
      what: '地点標高 (DEM10B / 5A 統合)。緯度経度から数 m 精度で取得。',
      label: 'GSI',
    },
  }),
  // 群馬県水位雨量情報システム ダム現況表 — 7 県管理ダム hourly (Shift_JIS HTML,
  // 坂本/霧積/塩沢/四万川/道平川/大仁田/桐生川). One fetch per station index (1–7);
  // timestamp "MM月DD日HH時mm分現在" JST (no year); volume in 千m³; arrow
  // indicators (→↑↓) stripped. Priority 308. Cron at :48.
  defineSource({
    id: 'gunma-kasen',
    priority: 308,
    description: '群馬県水位雨量情報システム ダム現況表 — 7 県管理ダム hourly',
    ingestCron: '48 * * * *',
    details: {
      label: '群馬県 水位雨量情報',
      upstream:
        '群馬県水位雨量情報システム ダム現況表 (www.river-gunma.jp/gunmaT/m4101/60/_0_{idx}_0.html)',
      license: null,
      cadence: '時次 (ページの「MM月DD日HH時mm分現在」値; 取得は毎時 :48)',
      what: '群馬県管理 7 ダム (坂本/霧積/塩沢/四万川/道平川/大仁田/桐生川) の貯水位・貯水量(千m³→m³)・流入量・放流量。値に付く増減矢印 (→↑↓) は除去。',
    },
  }),
  // 平戸市水道局 市内水道用ダムの貯水状況 — 神曽根/箕坪/阿奈田/神の川/桜川 (plus a
  // pond and two 砂防ダム outside the master), 貯水量 + 貯水率 on a 「…現在」 date,
  // re-issued about every ten days. Priority 293. Daily at 06:44 UTC (15:44 JST).
  defineSource({
    id: 'hirado-suido',
    priority: 293,
    description: '平戸市水道局 市内水道用ダムの貯水状況 — 5 ダム (約10日毎, 貯水量+貯水率)',
    trustedRateBasis: true,
    ingestCron: '44 6 * * *',
    // Re-issued about every ten days (R8.9.14 → 9.24), stamped with its own
    // date; a skipped edition plus a few days of lag. With one stamp the
    // derived threshold falls back to 3 × the daily poll and flags it at once.
    freshnessOverrideHours: 21 * 24,
    details: {
      upstream:
        '平戸市水道局「市内水道用ダムの貯水状況について」 (city.hirado.nagasaki.jp/kurashi/life/water/cyosuiritsu.html)',
      license:
        'サイト表記は「平戸市ホームページの文書・画像等のコンテンツに関する諸権利は，原則として平戸市に帰属します。ただし，一部の画像等の著作権は，コンテンツ提供者に帰属します。」「これらの平戸市ホームページ上の文書・画像などは、「私的使用のための複製」や「引用」など著作権法上認められた場合を除き、無断で使用・転載することを禁止します。」、フッターは「すべての情報・データの無断転載・複製等を禁ず。」。本サイトは観測値 (事実) のみを出典明示で引用。',
      cadence:
        '約 10 日毎 (「○月○日現在」, 時刻非公表のため 00:00 JST で記録; 取得は毎日 15:44 JST)',
      what: '平戸市の水道用 5 ダム (神曽根第2/箕坪/阿奈田/神の川/桜川) の貯水量(m³)・貯水率 (市の満水量比)。いずれも本ソース唯一の観測源。平床の池と轟川・東流川の砂防ダムは台帳 (国土数値情報) にないため一覧のみに記録。',
      label: '平戸市水道局',
    },
  }),
  // 広島県防災Web — 18 ダム (JSON feed, 10分更新). Pointer + list feed; storage
  // in 千m³. Prefectural (managerCd 23/24/26) + 5 MLIT dams already in
  // cgr-mlit-dam (priority 304 wins for those). Cron at :29.
  defineSource({
    id: 'hiroshima-bousai',
    priority: 310,
    description: '広島県防災Web — hourly, 18ダム (JSON feed, 10分更新)',
    trustedRateBasis: true,
    ingestCron: '29 * * * *',
    details: {
      upstream: '広島県防災Web (bousai.pref.hiroshima.lg.jp/dam) — /data/dam/list/{ts}.json',
      license: '公開情報 — 出典明示で再配布可',
      cadence: '時次 (元データは 10 分粒度; 取得は毎時 :29)',
      what: '広島県管理 18 ダムの貯水位・有効貯水量(千m³)・全流入量・全放流量・貯水率。県管理 12 + 国管理 5 (cgr-mlit-dam と重複) + 農水省 1。',
      label: '広島県防災Web',
    },
  }),
  // 国土交通省 北海道開発局 — 18 直轄 dams (info-dam.hdb.hkd.mlit.go.jp).
  // Page table has 10-minute cadence; we fetch hourly at :13 to spread load
  // from other prefectural sources.
  defineSource({
    id: 'hkd-mlit-dam',
    priority: 305,
    description: '国土交通省 北海道開発局 ダムリアルタイム情報 — hourly, 18 dams',
    ingestCron: '13 * * * *',
    // Hourly real-time sources — flag if older than 3 h.
    freshnessOverrideHours: 3,
    details: {
      upstream: '国土交通省 北海道開発局 ダムリアルタイム情報 (info-dam.hdb.hkd.mlit.go.jp)',
      license: '国の公式統計値 — 出典明示で再配布可',
      cadence: '時次 (元データは 10 分粒度; 取得は毎時 :13)',
      what: '北海道開発局直轄 18 ダム (平取/忠別/豊平峡/岩尾内/漁川/定山渓/金山/鹿ノ子/新桂沢/二風谷/美利河/留萌/サンル/札内川/大雪/滝里/十勝/夕張シューパロ) の貯水位・流入量・放流量・貯水量・貯水率。',
      label: '北海道開発局ダム',
    },
  }),
  // 国土交通省 北陸地方整備局 — 7 dams across 6 prefectures (福島/山形/
  // 新潟/長野/富山/石川). CSV-like tmDam.txt feed has current values for
  // all dams in one fetch. Cron at :19.
  defineSource({
    id: 'hrr-mlit-dam',
    priority: 302,
    description:
      '国土交通省 北陸地方整備局 ダム防災情報 — hourly, 7 dams (大川/大石/横川/三国川/大町/宇奈月/手取川)',
    ingestCron: '19 * * * *',
    details: {
      upstream: '国土交通省 北陸地方整備局 ダム防災情報 (hrr.mlit.go.jp/river/dam-bousai)',
      license: '国の公式統計値 — 出典明示で再配布可',
      cadence: '時次 (元データは 10 分粒度; 取得は毎時 :19)',
      what: '北陸地方整備局直轄 7 ダム (福島:大川 / 山形:横川 / 新潟:大石・三国川 / 長野:大町 / 富山:宇奈月 / 石川:手取川) の貯水位・流入量・放流量。',
      label: '北陸地方整備局ダム',
    },
  }),
  // 兵庫県 ダム諸量 — 22観測所 (BODIK オープンデータ CSV, CC-BY 4.0, 10分更新).
  // Single CSV fetch gives level / 貯水量(千m³) / inflow / outflow. Cron at :25.
  defineSource({
    id: 'hyogo-bodik',
    priority: 311,
    description: '兵庫県 ダム諸量 BODIK オープンデータ (CC-BY 4.0, 10分更新, 22観測所)',
    ingestCron: '25 * * * *',
    details: {
      upstream: '兵庫県 ダム諸量データ (data.bodik.jp/dataset/280003_dam_hyogo)',
      license: 'CC-BY 4.0 — 出典明示で再配布可',
      cadence: '時次 (元データは 10 分粒度; 取得は毎時 :25)',
      what: '兵庫県管理 ~20 ダム (青野/生野/引原/安室/金出地/与布土/諭鶴羽 ほか) の貯水位・貯水量(m³)・全流入量・全放流量。BODIK オープンデータ CSV。',
      label: '兵庫県オープンデータ',
    },
  }),
  // 兵庫県企業庁 貯水状況 — 県営水道 / 県営工業用水道の 10 水源, 「YYYY年M月D日現在」
  // (weekly, the Monday figures once compiled). Writes 神谷 only (volume + rate);
  // 黒川 is the 企業庁 share of a pumped-storage reservoir, 平荘 / 権現 are
  // reservoir totals, the rest have live feeds. Priority 289. Daily at 03:40 UTC
  // (12:40 JST).
  defineSource({
    id: 'hyogo-kigyo',
    priority: 289,
    description: '兵庫県企業庁 貯水状況 — 神谷ダム (週次 HTML, 貯水量+貯水率)',
    ingestCron: '40 3 * * *',
    // Weekly 「M月D日現在」 page, same slack as chiba-suisei: a skipped week plus
    // a day or two of publication lag after the survey date that is stamped.
    freshnessOverrideHours: 17 * 24,
    details: {
      upstream: '兵庫県企業庁 水道課「貯水状況」 (web.pref.hyogo.lg.jp/kc02/ea02_000000005.html)',
      license:
        'サイト表記は「兵庫県ホームページの全部もしくは一部について、「私的使用」「引用」など著作権法上認められている行為として適切な方法で利用する場合を除き、兵庫県に無断で複製・転用することはできません」。本サイトは観測値 (事実データ) のみを出典明示のうえ掲載。',
      cadence:
        '週次 (毎週月曜日 (祝日の際は翌日) の情報を取りまとめ次第更新; 「M月D日現在」の日付のみのため 00:00 JST で記録; 取得は日次 12:40 JST)',
      what: '県営水道・県営工業用水道の 10 水源の利水容量・貯水量(千m³)・貯水率。取り込むのは神谷ダムの貯水量・貯水率のみ (本ソース唯一の観測源)。黒川ダムは関西電力の揚水発電上池で、値は企業庁持分 (利水容量 3,980 千m³) のため保存しない。平荘・権現は複数堤体の貯水池合計、一庫/青野/呑吐/大川瀬/生野/引原は他のリアルタイムフィードで取得済み。',
      label: '兵庫県企業庁',
    },
  }),
  // 兵庫県 総合政策課「県内の水源の状況」— 県内主要水源の貯水率 (整数 %, 貯水量なし)。
  // 毎月1日現在の調査を10日前後に掲載、渇水時は頻度増。千苅/丸山/加古川大堰 と、
  // 貯水量のない鴨川 (渇水時は呑吐/大川瀬/但東も) を取り込み。他は貯水量のある
  // フィード (竹原/猪ノ鼻/猪鼻第2 は awaji-suido) があるため universe のみ。日次で
  // 調査日 00:00 JST へ冪等 UPSERT。
  defineSource({
    id: 'hyogo-suigen',
    priority: 287,
    description: '兵庫県 総合政策課 県内の水源の状況 — 主要水源の貯水率 (月1回程度, HTML)',
    ingestCron: '17 1 * * *',
    details: {
      upstream:
        '兵庫県 企画部 総合政策課「県内の水源の状況」 (web.pref.hyogo.lg.jp/kk05/ac07_000000162.html)',
      license:
        'サイト表記 (リンク・著作権・免責事項) は「兵庫県ホームページの全部もしくは一部について、『私的使用』『引用』など著作権法上認められている行為として適切な方法で利用する場合を除き、兵庫県に無断で複製・転用することはできません」。本サイトは観測値 (事実データ) のみを出典明示のうえ掲載。',
      cadence:
        '月 1 回程度 (毎月 1 日現在の調査を 10 日前後に掲載、渇水が予測される場合は頻度増; 日付のみのため 00:00 JST で記録; 取得は日次でポーリング)',
      what: '兵庫県の主要水源ダムの貯水率 (整数 %、各管理者の公表値)。貯水量・水位は非公開。千苅・丸山 (西宮市)・加古川大堰と、他のフィードが水位しか持たない鴨川 (渇水時に個別掲載される呑吐・大川瀬・但東も) を取り込む。青野・一庫・生野・成相・牛内などは 10 分値の貯水量が、竹原・猪ノ鼻・猪鼻第2 は淡路広域水道企業団 (awaji-suido) の貯水量があるため取り込まない。呑吐・大川瀬の合算行は 1 基に紐付けない。',
      label: '兵庫県 県内の水源の状況',
    },
  }),
  // 茨城県河川防災情報 — 7 県管理ダム (小山/飯田/藤井川/竜神/十王/花貫/花園).
  // 防災Web HTML table (Shift_JIS), no session required. 9 columns including
  // storage volume (千m³) but no 貯水率. Cron at :53.
  defineSource({
    id: 'ibaraki-bousai',
    priority: 308,
    description: '茨城県河川防災情報 ダム諸量現況表 — 防災Web HTML table, 7 dams, hourly',
    ingestCron: '53 * * * *',
    details: {
      label: '茨城県 河川防災情報',
      upstream:
        '茨城県河川防災情報 ダム諸量現況表 (www.kasen.pref.ibaraki.jp/pc/sv/bousaiTableStatus.html?sv=3&dk=4&mp=0&no=0&fn=0&pg=1)',
      license: null,
      cadence: '時次 (取得は毎時 :53)',
      what: '茨城県管理 7 ダム (小山/飯田/藤井川/竜神/十王/花貫/花園) の貯水位・貯水量 (千m³)・流入量・全放流量。貯水率の列はない。',
    },
  }),
  // 茨城県河川情報 霞ヶ浦 出島 水位グラフ — 霞ヶ浦開発 (NDI 597) の湖水位. 23 hourly
  // rows + the latest 10-minute row, gauge height + 零点高 (T.P.) + 0.8402 → Y.P.
  // All rows re-upserted each run. Priority 308. Cron at :13 (ibaraki-bousai, same
  // host, is at :53).
  defineSource({
    id: 'ibaraki-kasumigaura',
    priority: 308,
    description: '茨城県河川情報 霞ヶ浦 出島 水位 — 霞ヶ浦開発の湖水位 (Y.P.換算, 毎時 24 時間分)',
    ingestCron: '13 * * * *',
    details: {
      upstream:
        '茨城県河川情報 水位グラフ「出島（でじま）」 (kasen.pref.ibaraki.jp/pc/graph/gra_river_372_1.html — 霞ヶ浦河川事務所の観測所。水資源機構 霞ヶ浦用水管理所が「霞ヶ浦の水位状況」として案内する地点)',
      license:
        '利用条件の記載なし (トップページ「ご利用に際しての注意事項」は「ここで提供している観測情報は、あくまで参考値であり、水防上の警報発令を意味するものではありません。」「観測機器の故障等による異常値がそのまま表示されてしまう可能性がありますのでご注意ください。」のみ) — 観測値のみを出典明示で掲載',
      cadence: '時次 (正時値 23 時間分 + 最新 10 分値; 取得は毎時 :13、全行を毎回 upsert)',
      what: '霞ヶ浦開発 (霞ヶ浦そのものが貯水池) の湖水位。出島の水位 (量水標読み) に同ページの零点高 (T.P.) と Y.P.=T.P.+0.8402m (同システム注意事項) を加えて Y.P.m で保存 — 水資源機構・ダム諸量DB と同じ基準面。湖岸 1 地点の値で、湖内平均水位 (川の防災情報のみ) ではない。貯水量・貯水率は公表なし。',
      label: '霞ヶ浦 (出島)',
    },
  }),
  // 石川県河川総合情報システム ダム諸量 — 11 県管理ダム hourly JSON.
  // 八ヶ川/新内川/内川/赤瀬/我谷/九谷/小屋/北河内/辰巳/犀川/大日川.
  // item_10=貯水位 / item_20=貯水量(千m³) / item_50=流入量 / item_70=放流量.
  // Cron at :28 every hour.
  defineSource({
    id: 'ishikawa-kasen',
    priority: 308,
    description: '石川県河川総合情報システム ダム諸量 — 11 県管理ダム hourly JSON',
    ingestCron: '28 * * * *',
    details: {
      label: '石川県 河川総合情報',
      upstream:
        '石川県河川総合情報システム ダム諸量 (kasen.pref.ishikawa.lg.jp/dyn/dps/timeline) — /{YYYYMMDD}/{YYYYMMDD}_1_dam_60.json',
      license: null,
      cadence: '時次 (JST 日付の JSON を毎時再生成; 取得は毎時 :28)',
      what: '石川県管理 11 ダム (八ヶ川/新内川/内川/赤瀬/我谷/九谷/小屋/北河内/辰巳/犀川/大日川) の貯水位・貯水量(千m³)・全流入量・全放流量。手取川ダム (国) は他ソースで取得済みのため除外。',
    },
  }),
  // 岩手県河川情報システム — 10 県管理ダム (Gamen32Servlet, Shift_JIS, one
  // request per station). Columns: level / 貯水量(千m³) / inflow / outflow.
  // Cron at :57.
  defineSource({
    id: 'iwate-kasen',
    priority: 308,
    description: '岩手県河川情報システム — Gamen32Servlet, 10 dams, hourly',
    ingestCron: '57 * * * *',
    details: {
      label: '岩手県 河川情報システム',
      upstream:
        '岩手県河川情報システム ダム諸量経過表 (kasen.pref.iwate.jp/iwate/servlet/Gamen32Servlet — station=0〜9 を 1 局ずつ取得)',
      license: null,
      cadence: '時次 (直近 24 時間の時系列; 取得は毎時 :57)',
      what: '岩手県管理 10 ダム (綱取/簗川/滝/入畑/日向/早池峰/綾里川/鷹生/遠野/遠野第二) の貯水位・貯水量 (千m³→m³)・全流入量・全放流量。',
    },
  }),
  // 電源開発 (J-POWER) 奈半利川ダム情報公開サイト — 魚梁瀬/久木/平鍋 (高知, no other
  // feed covers them). One ダムグラフ page per dam: 12 half-hour columns of 貯水位
  // + 全流入量 + 全放流量 ending at the requested JST hour; no volume or rate.
  // Priority 301. Cron at :48, asking for the running hour so its :30 is read.
  defineSource({
    id: 'jpower-naharigawa',
    priority: 301,
    description: '電源開発 奈半利川ダム情報公開サイト — 魚梁瀬/久木/平鍋ダム (UTF-8 HTML, 30分値)',
    ingestCron: '48 * * * *',
    details: {
      upstream:
        '電源開発株式会社 (J-POWER) 奈半利川ダム情報公開サイト (jpower-naharigawa-daminfo.jp) — Pages/DamGraph01.aspx',
      license: '利用条件の記載なし (サイトに利用規約・著作権表記なし) — 観測値のみを出典明示で掲載',
      cadence: '30 分 (直近 6 時間の 30 分値; 取得は毎時 :48)',
      what: '電源開発管理の奈半利川 3 ダム (魚梁瀬/久木/平鍋) の貯水位 (EL.m)・全流入量・全放流量。全流入量は逆算値で負値もそのまま公開。雨量は流域平均のため保存せず、貯水量・貯水率は非公開。3 ダムとも本ソース唯一の観測源。',
      label: '電源開発 奈半利川',
    },
  }),
  // 水資源機構 愛知用水総合管理所 水情報 — 牧尾 / 東郷調整池 / 前山池. Daily 0時
  // JST values, page updated ~10:00 JST; 02:20 UTC = 11:20 JST, retried 05:20
  // UTC for a late update (idempotent upsert on the 0時 timestamp).
  defineSource({
    id: 'jwa-aichi-yosui',
    priority: 294,
    description:
      '水資源機構 愛知用水総合管理所 水情報 — daily 0時, 3 施設 (牧尾/東郷調整池/前山池)',
    ingestCron: '20 2,5 * * *',
    details: {
      upstream:
        '水資源機構 愛知用水総合管理所 水情報 (water.go.jp/chubu/aityosui/b(jyouhou-main)/02(mizu)/00(top)/b-02.html)',
      license:
        '愛知用水総合管理所 サイトポリシー「著作権について」: 「当サイトの内容について、私的使用または引用等、著作権法上認めらた行為を除き、当方に無断で転載等を行うことはできません。また、引用を行う際は適宜の方法により、必ず出所を明示してください。」 水資源機構「著作権・リンク等について」(water.go.jp/honsya/honsya/policy/copyright/): 「数値データ、簡単な表・グラフ等は著作権の対象ではありませんので、これらについては本利用ルールの適用はなく、自由に利用できます。」 本サイトは観測値 (数値データ) のみを出所明示のうえ保持。',
      cadence:
        '日次 (貯水位・貯水量・貯水率は 0 時 JST 値, 元ページは 10 時頃更新; 取得は 11:20 / 14:20 JST)',
      what: '愛知用水の東郷調整池 (愛知池)・前山池 と水源の牧尾ダムの貯水位・貯水量(千m³→m³)・貯水率 (有効貯水量比)。牧尾の流入量・放流量は前日の日平均値のため取り込まない。東郷調整池・前山は他に公開ソースのない新規カバレッジ。',
      label: 'JWA 愛知用水',
    },
  }),
  // 水資源機構 琵琶湖総合管理所 堰諸量 — 琵琶湖 (master 琵琶湖開発). daminfo1_h.json,
  // 25 hourly rows: B.S.L. level (stored as T.P. = B.S.L. + 84.371 m), lake
  // 総流入量 / 総流出量. Priority 297. Cron at :58.
  defineSource({
    id: 'jwa-biwako',
    priority: 297,
    description:
      '水資源機構 琵琶湖総合管理所 堰諸量 — 琵琶湖 水位 (B.S.L.→T.P.)・総流入量・総流出量, hourly',
    ingestCron: '58 * * * *',
    details: {
      upstream: '水資源機構 琵琶湖総合管理所 堰諸量 (biwako-mizukanri.jp/daminfo1_h.html)',
      license:
        '水資源機構ウェブサイト利用ルール (政府標準利用規約 第2.0版準拠、CC BY 4.0 互換): 出典記載のうえ複製・加工・商用利用可。数値データは著作権の対象外として自由に利用可。',
      cadence: '時次 (直近 25 時間分の 1 時間値; 取得は毎時 :58)',
      what: '琵琶湖 (琵琶湖開発) の琵琶湖水位 (B.S.L. を T.P. 標高 = B.S.L. + 84.371 m に換算)・総流入量・総流出量。貯水量・貯水率は非公開。',
      label: 'JWA 琵琶湖',
    },
  }),
  // 水資源機構 千葉用水総合管理所 房総導水路管理所 — 長柄ダム / 東金ダム 日次 (HTML, 閉庁日除く).
  // Manually updated page: water level (EL.m) + storage rate (%) at midnight JST.
  // Not on 千葉県水道局 page — JWA-managed, not prefecture-managed.
  // Priority 302. Cron daily at 03:00 UTC = 12:00 JST.
  defineSource({
    id: 'jwa-chiba-bouso',
    priority: 302,
    description: '水資源機構 千葉用水総合管理所 — 長柄・東金ダム日次 (EL水位+貯水率)',
    ingestCron: '0 3 * * *',
    details: {
      label: 'JWA 房総導水路',
      upstream:
        '水資源機構 千葉用水総合管理所 房総導水路管理所 (www.water.go.jp/kanto/bouso/01shinchaku/syusuijouhou/syusuijouhou.html)',
      license: null,
      cadence: '日次 (閉庁日を除き手動更新, 当日 0 時 JST 値; 取得は毎日 12:00 JST)',
      what: '房総導水路の長柄ダム・東金ダム (千葉県) の貯水位 (EL.m) と貯水率 (%)。貯水量・流量は掲載なし。千葉県水道局のダムとは別施設。',
    },
  }),
  // JWA Chikugo (筑後川 7 dams: 松原/下筌/大山/合所/江川/寺内/小石原川). Page
  // carries one dated 0時 edition per business day (none on 閉庁日), published
  // at no fixed hour — often after 10:00 JST. Rows are stamped with the page's
  // own date, so each run just upserts whichever edition is up. 01:00 and 08:00
  // UTC = 10:00 and 17:00 JST: the late run catches an edition before the next
  // morning's replaces it.
  defineSource({
    id: 'jwa-chikugo',
    priority: 297,
    description: '水資源機構 筑後川ダム統合管理事務所 — daily 0時, 7 dams',
    trustedRateBasis: true,
    ingestCron: '0 1,8 * * *',
    details: {
      upstream:
        '水資源機構 筑後川ダム統合管理事務所 (water.go.jp/chikugo/chikugo/water-source.html)',
      license: '公的統計 — 出典明示で再配布可',
      cadence: '日次 (開庁日のみ, 見出しの日付の 0:00 JST 値; 取得は 10:00 / 17:00 JST)',
      what: '筑後川水系 7 ダム (松原/下筌/大山/合所/江川/寺内/小石原川) の貯水率・貯水量。',
      label: 'JWA 筑後川',
    },
  }),
  // JWA 筑後川局 水管理情報WEB (chikugo.ec-net.jp) — hourly, 5 施設
  // (江川/寺内/小石原川/大山/筑後大堰). Each rep*_I60 page is a 24-row hourly
  // table regenerated at ~:37; the whole window is upserted. Priority 298: above
  // jwa-chikugo (297), below kasenbosai (310). 筑後大堰's only other source is
  // mudam (historical, daily to 2024-12).
  // Cron at :50.
  defineSource({
    id: 'jwa-chikugo-rt',
    priority: 298,
    description:
      '水資源機構 筑後川局 水管理情報WEB — hourly, 5 施設 (江川/寺内/小石原川/大山/筑後大堰)',
    trustedRateBasis: true,
    ingestCron: '50 * * * *',
    details: {
      upstream:
        '水資源機構 筑後川局 水管理情報WEB (chikugo.ec-net.jp/chikugo/kyoku/pc/new/rep{EG,TR,KB,OY,CO}_I60.html)',
      license:
        '水資源機構 利用ルール — 出典を記載すれば複製・公衆送信・翻案・商用利用可; 数値データは著作権の対象外 (water.go.jp/honsya/honsya/policy/copyright/)',
      cadence: '時次 (毎正時値, ~37 分に更新; 取得は毎時 :50, 直近 24 時間分を毎回 UPSERT)',
      what: '筑後川水系 5 施設 (江川/寺内/小石原川/大山ダム, 筑後大堰) の貯水位・有効貯水量・貯水率 (利水等の貯水容量比)・流入量・総放流量・時間雨量。筑後大堰は貯水位・時間雨量のみ (有効貯水量欄は容量 930 千m³ の固定値のため保存しない) で、現行の唯一のソース; 各ダムは jwa-chikugo (日次 0 時) を時次に格上げ。',
      label: 'JWA 筑後川 時次',
    },
  }),
  // 水資源機構 中部支社 — 木曽川水系 5 dams (牧尾/阿木川/味噌川/岩屋/徳山) + 三重用水 中里.
  // Daily static HTML; 0時 EL + 千m³ storage + 利水 rate + inflow/outflow. New: 中里ダム.
  // The report comes out once per weekday, 09:40–11:40 JST (first seen 10:12–11:41
  // on prod, 2026-08-31..09-25), and the 中部支社 site asks users not to collect
  // with tools (server load). So 3 fetches per weekday — 01:41 / 03:41 / 06:41 UTC
  // = 10:41 / 12:41 / 15:41 JST — instead of 24 a day.
  defineSource({
    id: 'jwa-chubu',
    priority: 296,
    description: '水資源機構 中部支社 木曽川水系 — daily, 6 dams with inflow/outflow',
    ingestCron: '41 1,3,6 * * 1-5',
    details: {
      upstream: '水資源機構 中部支社 (water.go.jp/mizu/chubu/report/)',
      license: `${JWA_CHUBU_TERMS} 報告は平日 1 回の掲載のため、取得は平日 3 回 (1 回 1 ページ) に抑えている。`,
      cadence:
        '平日日次 (当日 0 時値, 平日 09:40〜11:40 JST 頃掲載; 取得は平日 10:41 / 12:41 / 15:41 JST)',
      what: '木曽川水系 5 ダム (牧尾/阿木川/味噌川/岩屋/徳山) と三重用水 中里ダム (三重県いなべ市) の 0時の貯水位(EL.m)・貯水量(千m³)・貯水率(利水容量比)・前日平均の流入量・放流量。中里ダムは新規カバレッジ; 他 5 ダムは jwa-junpo より日次で詳細なデータを提供。',
      label: 'JWA 中部支社',
    },
  }),
  // JWA 筑後川局 福岡導水管理室 — 山口調整池 (天拝湖). One page with the day's
  // 0時 reading, regenerated on weekdays at ~04:30 JST; idempotent upsert on the
  // report hour, so hourly polling costs nothing. Cron at :54.
  defineSource({
    id: 'jwa-fukudou',
    priority: 297,
    description: '水資源機構 筑後川局 福岡導水管理室 — 山口調整池 日次 0時 (貯水位・総貯水量)',
    ingestCron: '54 * * * *',
    details: {
      upstream: '水資源機構 筑後川局 福岡導水管理室 (water.go.jp/chikugo/fukudou/html/info02.html)',
      license:
        '水資源機構 利用ルール — 出典を記載すれば複製・公衆送信・翻案・商用利用可; 数値データは著作権の対象外 (water.go.jp/honsya/honsya/policy/copyright/)',
      cadence: '日次 (平日 ~04:30 JST に当日 0 時値を掲載; 取得は毎時 :54)',
      what: '山口調整池 (天拝湖, 福岡導水) の貯水位 (EL.m) と総貯水量。総貯水量から堆砂容量 (総 − 有効) を差し引いた有効分を保存; 公表貯水率は総貯水容量比のため保存しない。他ソースなしの新規カバレッジ。',
      label: 'JWA 福岡導水',
    },
  }),
  // JWA 旬報 — 21 dams across 7 major water systems (Tonegawa, Arakawa, Kisogawa,
  // Toyokawa, Yodogawa, Yoshinogawa, Chikugogawa). Published every 10 days
  // (1st/11th/21st of each month JST). Daily polling at 04:00 UTC = 13:00 JST
  // is cheap (idempotent UPSERT on the report-date timestamp) and catches a
  // new publication within ~24 h regardless of which exact day it lands on.
  defineSource({
    id: 'jwa-junpo',
    priority: 290,
    description: '水資源機構 旬報 (real, 10-day cadence, statutory open data)',
    trustedRateBasis: true,
    ingestCron: '0 4 * * *',
    // 10-day cadence — flag if older than 14 days.
    freshnessOverrideHours: 14 * 24,
    details: {
      upstream: '水資源機構 旬報 (water.go.jp/honsya/honsya/suigen/junpo/index.html)',
      license: '統計法に基づく公的統計 (出典明示で再配布可)',
      cadence: '10 日毎 (毎月 1 / 11 / 21 日 JST 公表; 取得は日次でポーリング)',
      what: '水資源機構が管理する全国 26 ダムの利水容量・貯水量 (千m³)・貯水率 (現在 / 平年 / 平年比)。',
      label: '水資源機構 旬報',
    },
  }),
  // 水資源機構 中部支社 木曽川水系 実時計 — all 12 facilities on the map: 牧尾/味噌川/
  // 阿木川/岩屋/徳山, 三重用水 中里 + 調整池, 長良川河口堰, 木曽川大堰. Real-time page
  // (~10 min cadence); 貯水位(EL.m) or 堰上流水位 + 有効貯水量(10³m³) + inflow/outflow.
  // Priority 297, above jwa-chubu (296, daily). One page per run; cron at :47.
  defineSource({
    id: 'jwa-kiso-rt',
    priority: 297,
    description:
      '水資源機構 中部支社 木曽川水系 実時計 — hourly, 12 facilities (5 dams, 三重用水 中里 + 調整池, 長良川河口堰, 木曽川大堰)',
    ingestCron: '47 * * * *',
    details: {
      upstream:
        '水資源機構 中部支社 木曽川水系 実時計 (water.go.jp/mizu/chubu/realtime/index.html)',
      license: `${JWA_CHUBU_TERMS} 取得は 1 回 1 ページ、毎時 1 回に抑えている。`,
      cadence: '時次 (元データは ~10 分粒度; 取得は毎時 :47)',
      what: '木曽川水系の実時計に載る 12 施設すべて: 牧尾・味噌川・阿木川・岩屋・徳山ダムの貯水位(EL.m)・有効貯水量(千m³→m³)・流入量・放流量、打上調整池と三重用水の中里貯水池・宮川・菰野・加佐登調整池の貯水位・有効貯水量、長良川河口堰・木曽川大堰の堰上流水位・流入量・流出量 (放流量)。jwa-chubu (日次, 優先度 296) を時次に格上げ; 宮川調整池・長良川河口堰は他に公開ソースのない新規カバレッジ。',
      label: 'JWA 木曽川 実時計',
    },
  }),
  // 水資源機構 関東支社 利根川/荒川系 — 13 facilities (9 Tone + 4 Ara).
  // Daily 0時 JST static HTML; 万m³ units. New dams: 藤原/相俣/薗原/八ッ場/二瀬.
  // Overlap dams (矢木沢/奈良俣/下久保/草木/浦山/滝沢) get daily cadence. Cron at :39.
  defineSource({
    id: 'jwa-toneara',
    priority: 296,
    description: '水資源機構 関東支社 利根川/荒川系 — daily 0時, 13 facilities',
    trustedRateBasis: true,
    ingestCron: '39 * * * *',
    details: {
      upstream: '水資源機構 関東支社 (water.go.jp/honsya/honsya/suigen/sokuhou/toneara/index.html)',
      license: '公的統計 — 出典明示で再配布可',
      cadence: '日次 (毎日 0:00 JST 値; 取得は毎時 :39)',
      what: '利根川水系 9 施設 (矢木沢/奈良俣/藤原/相俣/薗原/八ッ場/下久保/草木/渡良瀬貯水池) と荒川水系 4 施設 (二瀬/滝沢/浦山/荒川貯水池) の貯水量(万m³)・貯水率。藤原/相俣/薗原/八ッ場/二瀬は新規カバレッジ。',
      label: 'JWA 利根川/荒川',
    },
  }),
  // 水資源機構 利根川河口堰管理所 利根河口堰 情報提供 — 1 weir (茨城/千葉境).
  // 正時水位表 + 正時流量表 script files (24 h rolling); 堰上流水位 (新宿 19.0km,
  // Y.P.m) + 堰流入量 + 堰通過流量. All 24 hours re-upserted each run, so a
  // missed hour back-fills. Priority 298. Cron at :30.
  defineSource({
    id: 'jwa-tonekako',
    priority: 298,
    description:
      '水資源機構 利根川河口堰管理所 利根河口堰 情報提供 — 堰上流水位(Y.P.)・堰流入量 hourly',
    ingestCron: '30 * * * *',
    // Hourly real-time sources — flag if older than 3 h.
    freshnessOverrideHours: 3,
    details: {
      upstream:
        '水資源機構 利根川河口堰管理所 利根河口堰 情報提供 (tonekako.sakura.ne.jp — water.go.jp/honsya/honsya/suigen/realtime/ からリンク)',
      license:
        '水資源機構ウェブサイト利用ルール — 「数値データ、簡単な表・グラフ等は著作権の対象ではありません…自由に利用できます」(出典: 独立行政法人水資源機構)',
      cadence: '時次 (正時値・直近 24 時間; 取得は毎時 :30、24 時間分を毎回 upsert)',
      what: '利根川河口堰 (茨城/千葉境) の堰上流水位 (新宿 19.0km, Y.P.m)・堰流入量・堰通過流量 (ゲート全開時は ** = 欠測扱い)。貯水量・貯水率は公表なし。他に実時間データのない施設。',
      label: 'JWA 利根川河口堰',
    },
  }),
  // 水資源機構 中部支社 豊川水系 — all 14 facilities on the map: 宇連/大島, the
  // 豊川用水 調整池 and 頭首工. Real-time page updated every ~10 min; water level
  // (EL.m) + 有効貯水量(10³m³) + inflow; no outflow (the page prints only
  // 放流量（利水）). One page per run; cron at :43.
  defineSource({
    id: 'jwa-toyokawa',
    priority: 298,
    description:
      '水資源機構 中部支社 豊川水系 — real-time (~10 min), 14 facilities (宇連/大島 + 豊川用水 調整池・頭首工)',
    ingestCron: '43 * * * *',
    details: {
      upstream: '水資源機構 中部支社 豊川水系 (water.go.jp/mizu/chubu/realtime/index_2.html)',
      license: `${JWA_CHUBU_TERMS} 取得は 1 回 1 ページ、毎時 1 回に抑えている。`,
      cadence: '時次 (元データは ~10 分粒度; 取得は毎時 :43)',
      what: '豊川水系の実時計に載る 14 施設すべて: 宇連・大島ダムの貯水位(EL.m)・有効貯水量(10³m³→m³)・流入量、豊川用水の調整池 (大原・万場・初立池・駒場池・蒲郡、ほか三ツ口池・芦ヶ池) の貯水位・有効貯水量、頭首工 5 か所の水位。ページの放流量は放流量（利水）のみで全放流量ではないため保存しない。宇連・大島は jwa-junpo (10 日) / aitoyo (日次) より高頻度; 調整池 5 か所と大野頭首工は他に公開ソースのない新規カバレッジ。三ツ口池・芦ヶ池と大野以外の頭首工はダム台帳 (国土数値情報) にないため取り込まない。',
      label: 'JWA 豊川',
    },
  }),
  // 水資源機構 吉野川上流総合管理所 — 5 dams (池田/早明浦/新宮/富郷/柳瀬).
  // Hourly real-time page (UTF-8); 貯水位(EL.m) + 流入量 + 全放流量 for all 5.
  // 早明浦ダムのみ利水貯水率[速報値]あり (四国の水不足指標). Cron at :45.
  defineSource({
    id: 'jwa-yoshino',
    priority: 297,
    description: '水資源機構 吉野川上流総管 — hourly, 5 dams (池田/早明浦/新宮/富郷/柳瀬)',
    trustedRateBasis: true,
    ingestCron: '45 * * * *',
    details: {
      upstream:
        '水資源機構 吉野川上流総合管理所 (water.go.jp/mizu/ikeda/mizuinfo/dyn/html/p0001/60/p000101.html)',
      license: '公的統計 — 出典明示で再配布可',
      cadence: '時次 (元データは 5 分粒度で自動更新; 取得は毎時 :45)',
      what: '吉野川水系 5 ダム (池田/早明浦/新宮/富郷/柳瀬) の貯水位(EL.m)・流入量・全放流量。早明浦ダムのみ利水貯水率[速報値]も提供 (四国の水不足予測の主要指標)。jwa-junpo (10 日) より高頻度で水位も追加。',
      label: 'JWA 吉野川',
    },
  }),
  // かがわ防災Webポータル ダム諸量 — 18 ダム (椛川/門入/千足/内海/吉田/内場/野口/
  // 長柄/前山/殿川/粟井/五名/田万/大川/大内/五郷/府中/粟地). Single JSON fetch;
  // clean structured data with storageRate + storageVolumeM3 + waterLevel +
  // inflow + outflow. Updated every 10 min. Cron at :39.
  defineSource({
    id: 'kagawa-bousai',
    priority: 308,
    description: 'かがわ防災Webポータル ダム諸量 — 18 ダム hourly JSON',
    trustedRateBasis: true,
    ingestCron: '39 * * * *',
    details: {
      label: 'かがわ防災Webポータル',
      upstream:
        'かがわ防災Webポータル ダム諸量 (www.bousai-kagawa.jp/bousai_data/tm/dam_station.json)',
      license: null,
      cadence: '10分更新 (毎時 :39 に取得)',
      what: '香川県の 18 ダム (椛川 (試験湛水)/門入/千足/内海/吉田/内場/野口/長柄/前山/殿川/粟井/五名/田万/大川/大内/五郷/府中/粟地) の貯水位・貯水量 (千m³)・貯水率・流入量・全放流量。1 回の JSON 取得で全ダム分。',
    },
  }),
  // 香川県 水資源対策課「かがわの水」— ページ本文の宝山湖 (香川用水調整池, 0.1 %, H時現在) と
  // 降雨及び貯水率の状況 PDF の主要ため池 26 か所の
  // 貯水率 (整数 %)。PDF は開庁日毎、ため池欄は月2回程度の調査日 (M月D日現在)。
  defineSource({
    id: 'kagawa-tameike',
    priority: 283,
    description:
      '香川県 水資源対策課 降雨及び貯水率の状況 — 主要ため池 26 か所 (月2回程度) と宝山湖の貯水率',
    ingestCron: '50 5 * * *',
    details: {
      upstream:
        '香川県 水資源対策課「かがわの水」降雨及び貯水率の状況 (pref.kagawa.lg.jp/mizusigen/mizu/kfvn.html 本文の宝山湖欄 + リンク先の chosuiYYYYMMDD.pdf)',
      license:
        'サイト表記は「私的使用または引用など著作権法上認められた行為として、適宜の方法により出所を明示することにより、引用・転載複製を行うことができます」(無断改変は不可)。',
      cadence:
        'PDF とページは開庁日毎。宝山湖は掲載時刻 (例: 9時現在) ベース、ため池貯水率は月 2 回程度の調査日 (M月D日現在) ベース (取得は日次でポーリング)',
      what: '香川県の主要ため池 26 か所 (満濃池・公渕池・神内池・仁池・豊稔池 ほか) の貯水率 (整数 %) と、宝山湖 (香川用水調整池) の貯水率 (0.1 %)。貯水量・水位は非公開 (宝山湖の容量は「3百万立方メートル」の概数のみ)。同 PDF の県内ダム欄は kagawa-bousai が毎時で持つため取り込まない。',
      label: '香川県 主要ため池・宝山湖',
    },
  }),
  // Historical ZIP archives (monthly updates). Run on demand:
  //   add_job('backfill:kagoshima-bodik', { fromYear: 2024 })  -- recent years
  //   add_job('backfill:kagoshima-bodik', {})                  -- full 2008+ history
  defineSource({
    id: 'kagoshima-bodik',
    priority: 296,
    description: '鹿児島県 BODIK ダム諸量 — 3 dams (大和/川辺/西之谷), 10-min, 2008+, CC-BY',
    // Backfill-only (no crontab entry): historical keeps it outside the gate.
    status: 'historical',
    details: {
      label: '鹿児島県オープンデータ',
      upstream:
        '鹿児島県 ダム諸量 — BODIK オープンデータ (data.bodik.jp/dataset/1b0c5baf-e309-4ad3-8c31-a4dc3cc9781f)',
      license: null,
      cadence: '過去データの一括取込 (ZIP アーカイブは月次更新; cron なし・手動実行)',
      what: '鹿児島県 3 ダム (大和/川辺/西之谷) の 2008 年以降の 10 分値 — 貯水位・貯水量(千m³)・貯水率・全流入量・全放流量。月別 Shift_JIS CSV を ZIP で取得し、空容量は保存しない。',
    },
  }),
  // 鹿児島県防災ポータル ダム情報 — 県管理ダム (JSON API, globally accessible).
  // NOTE: Returns empty items during normal conditions; populated only during
  // active flood/disaster events. Adapter exits early when no data present.
  defineSource({
    id: 'kagoshima-bousai',
    priority: 308,
    description: '鹿児島県防災ポータル ダム情報 — JSON API, hourly (active during flood events)',
    universeEnumerable: false,
    ingestCron: '56 * * * *',
    // The portal lists dams only during a flood or disaster; empty otherwise.
    freshnessOverrideHours: null,
    details: {
      label: '鹿児島県 防災ポータル',
      upstream:
        '鹿児島県防災ポータル ダム情報 (www.bousai-kagoshima.jp/bousai_data/tm/dam_station.json)',
      license: null,
      cadence: '出水・災害時のみ (平常時は items が空; 取得は毎時 :56)',
      what: '鹿児島県管理ダムの貯水位・貯水量 (千m³→m³)・流入量・放流量。平常時はデータが空で出水・災害時のみ値が入る (値の入った状態はまだ確認されていない)。',
    },
  }),
  // 鹿児島県河川砂防情報システム ダム一覧表 — 3 県管理ダム (西之谷/川辺/大和).
  // Published continuously, unlike the portal above. 防災Web servlet dk=4,
  // Shift_JIS HTML, 10-min values; 貯水率（利水） is the stored rate.
  // Priority 309 (above the flood-only kagoshima-bousai at 308). Cron at :52.
  defineSource({
    id: 'kagoshima-kasen',
    priority: 309,
    description: '鹿児島県河川砂防情報システム ダム一覧表 — 3 ダム (Shift_JIS HTML, 10分更新)',
    trustedRateBasis: true,
    ingestCron: '52 * * * *',
    details: {
      label: '鹿児島県 河川砂防情報',
      upstream:
        '鹿児島県河川砂防情報システム ダム一覧表 (www3.doboku-bousai.pref.kagoshima.jp/bousai/servlet/bousaiweb.servletBousaiTableStatus?dk=4)',
      license: null,
      cadence: '10 分更新 (常時公開; 取得は毎時 :52)',
      what: '鹿児島県管理 3 ダム (西之谷/川辺/大和) の貯水位・貯水量(千m³→m³)・全流入量・全放流量・貯水率 (利水)。治水専用の西之谷は貯水率（治水）のみの公表のため貯水率は保存しない。洪水時のみ公開の kagoshima-bousai より優先。',
    },
  }),
  // かながわの水がめ JSON API — 5 prefectural dams (相模/城山/三保/宮ヶ瀬/道志).
  // A 30-day DAILY window (24:00 JST values; lastUpdate rolls at ~01:00 JST),
  // upserted whole so a missed poll heals. Every 3 h at :35 — the 16:35 UTC
  // (01:35 JST) run catches the rollover, the rest cover a late one.
  defineSource({
    id: 'kanagawa-dam',
    priority: 310,
    description:
      'かながわの水がめ (kanagawa-dam.jp) — daily 24時値, 5 dams (相模/城山/三保/宮ヶ瀬/道志)',
    ingestCron: '35 1,4,7,10,13,16,19,22 * * *',
    // Daily sources — flag if older than 30 h (allows late publish day).
    // 30-day daily window stamped at 24:00 JST, rolled over at ~01:00 JST and
    // polled every 3 h; the derived 3 × 24 h + lag would wait three days.
    freshnessOverrideHours: 30,
    details: {
      upstream: 'かながわの水がめ (kanagawa-dam.jp) — JSON API `summary.php`',
      license: '神奈川県企業庁 — 出典明示で再配布可 (推定)',
      cadence: '日次 (24:00 JST 値; 直近 30 日分を 3 時間ごとに取得, 更新は ~01:00 JST)',
      what: '神奈川県 5 ダム (相模/城山/三保/宮ヶ瀬/道志) の貯水位・貯水量・貯水率 (24:00 値) と流入量・放流量 (日平均)。',
      label: 'かながわの水がめ',
    },
  }),
  // 神奈川県雨量水位情報 — 飯泉取水堰 (NDI 727) 15分水位, last 6 h per page, all
  // re-upserted each run. Level only, as published. Priority 308. Cron at :43.
  defineSource({
    id: 'kanagawa-suibou',
    priority: 308,
    description: '神奈川県雨量水位情報 — 飯泉取水堰 堰上水位 (15分値, 直近 6 時間を毎時取得)',
    ingestCron: '43 * * * *',
    details: {
      upstream:
        '神奈川県雨量水位情報 水位グラフ(15分)「飯泉取水堰」 (pref.kanagawa.jp/sys/suibou/web_general/suibou_joho/html/stage/15/p10202_18_3585_4_1601.html)',
      license:
        '神奈川県ウェブサイト サイトポリシー (pref.kanagawa.jp/master/sitepolicy.html): 「神奈川県ウェブサイトに掲載されているコンテンツ（文章、イラスト、写真、動画など）は、著作権の対象となっています。「引用」等の著作権法上認められている範囲において、自由にご利用になれます。」「コンテンツを利用する際には、出典を記載してください。」 — 観測値のみを出典明示で掲載',
      cadence: '15 分値 (ページは直近 6 時間 24 行; 取得は毎時 :43、全行を毎回 upsert)',
      what: '飯泉取水堰 (酒匂川, 神奈川県内広域水道企業団) の堰上水位 (m, 公表値のまま — ページに基準面の記載なし)。流量・貯水量は公表なし。他に実時間データのない施設。',
      label: '飯泉取水堰',
    },
  }),
  // 苅田町水道課 水源の状況 — 油木/山口 (and 井ノ口池, outside the master), 貯水量 +
  // 貯水率 on a daily 「…現在」 date. Priority 293. Daily at 06:13 UTC (15:13 JST).
  defineSource({
    id: 'kanda-suido',
    priority: 293,
    description: '苅田町水道課 水源の状況 — 油木/山口 (日次, 貯水量+貯水率)',
    trustedRateBasis: true,
    ingestCron: '13 6 * * *',
    details: {
      upstream:
        '苅田町水道課「水道の安定供給と安全性」水源の状況 (town.kanda.lg.jp/page/2021.html)',
      license:
        'サイト表記は「苅田町ホームページに掲載している内容（文章、写真、図、イラスト、音声・動画等）に関する著作権は、原則として苅田町に帰属します。」「苅田町ホームページの内容について、「私的使用のための複製」や「引用」など著作権法上認められた場合を除き、無断で複製・転用することはできません。」。本サイトは観測値 (事実) のみを出典明示で引用。',
      cadence: '日次 (「○月○日現在」, 時刻非公表のため 00:00 JST で記録; 取得は 15:13 JST)',
      what: '苅田町の水源 (福岡県営 山口ダム・油木ダム) の貯水量(千m³)・貯水率。山口ダムは本ソース唯一の観測源。井ノ口池は台帳 (国土数値情報) にないため一覧のみに記録。',
      label: '苅田町水道課',
    },
  }),
  // 川の防災情報 v2 — 800+ dams via tmlist/dam/{date}/{time}/{obs_fcd}.json.
  // Requires match:kasenbosai to have seeded external_ids.kasenbosai first.
  // Snap to 10-min cadence at :03 (give the source 3 min headroom past the
  // 10-min boundary, then concurrent fetches across 800+ dams take ~3 min
  // at concurrency=8).
  //
  // match:kasenbosai:
  // Seed / refresh external_ids.kasenbosai by sweeping the kawabou dam catalogue
  // GeoJSON (49 prefecture files, ~900 dams) and matching by name + distance.
  // Weekly on Monday 03:30 UTC (12:30 JST). After first run this cron keeps new
  // dams matched as the kawabou catalogue grows.
  defineSource({
    id: 'kasenbosai',
    priority: 310,
    description:
      '国土交通省 川の防災情報 (MLIT SCC) — 全国 800+ ダム / 10-min cadence per-dam JSON',
    trustedRateBasis: true,
    ingestCron: '3 * * * *',
    ingestTask: 'ingest:kasenbosai-v2',
    jobs: [{ cron: '30 3 * * 1', task: 'match:kasenbosai' }],
    details: {
      upstream: '国土交通省 川の防災情報 (river.go.jp) — tmlist/dam per-obs JSON',
      license: '国の公式統計値 — 出典明示で再配布可',
      cadence: '時次 (元データは 10 分粒度; 取得は毎時 :03)',
      what: '全国 ~870 ダムの 10 分粒度 貯水位・貯水量・有効容量貯水率・全流入量・全放流量。MLIT SCC の per-dam tmlist/dam/{obs_fcd}.json から取得。',
      label: '川の防災情報',
    },
  }),
  // 北九州市上下水道局 北九州市の水源状況 — 10 水源 (油木/ます渕/耶馬渓/力丸/頓田/
  // 畑/白木/道原/松ヶ江/遠賀川河口堰), 水位 + 貯水量 + 貯水率 at 09:00 JST.
  // Refreshed on weekdays around 16:00 JST; daily at 08:50 UTC (17:50 JST).
  defineSource({
    id: 'kitakyushu-suido',
    priority: 300,
    description: '北九州市上下水道局 北九州市の水源状況 — 10 水源 (水位+貯水量+貯水率, 平日日次)',
    trustedRateBasis: true,
    ingestCron: '50 8 * * *',
    details: {
      upstream:
        '北九州市上下水道局「北九州市の水源状況」 (city.kitakyushu.lg.jp/suidou/s00900011.html)',
      license:
        'サイト表記は「北九州市ホームページに掲載している内容 (文章、写真、図、イラスト、音声・動画等) に関する著作権は、原則として北九州市に帰属します。…「私的使用のための複製」や「引用」など著作権法上認められた場合を除き、無断で複製・転用することはできません」。本サイトは観測値 (事実) のみを出典明示で引用。',
      cadence: '平日日次 (09:00 JST 値, 平日 16 時頃更新; 取得は 17:50 JST)',
      what: '北九州市の 10 水源 (油木/ます渕/耶馬渓/力丸/頓田/畑/白木/道原/松ヶ江/遠賀川河口堰) の水位・貯水量(万m³)・貯水率。白木/道原/松ヶ江/遠賀川河口堰は新規カバレッジ。頓田は 2 ダム (頓田第1/第2) の合算値のため未紐付け。',
      label: '北九州市上下水道局',
    },
  }),
  // 国土交通省 近畿地方整備局 — 12 国管理ダム 貯水率 (JSON feed, 日次, 土日祝除く).
  // managawa/kuzuryu (Fukui), amagase/hiyoshi (Kyoto), muro/syourenji/takayama/
  // nunome/hinati/otaki/sarutani (Nara/Mie), hitokura (Hyogo). storageRate only.
  // Cron at 03:00 UTC = 12:00 JST on weekdays. Weekend runs return same data
  // (or cached page); UPSERT on (dam_id, observed_at, source_id) is idempotent.
  defineSource({
    id: 'kkr-mlit-dam',
    priority: 302,
    description: '国土交通省 近畿地方整備局 — 12 国管理ダム 貯水率 (JSON, 日次, 土日祝除く)',
    ingestCron: '0 3 * * *',
    details: {
      label: '国交省 近畿地整',
      upstream:
        '国土交通省 近畿地方整備局 ダム貯水率 JSON (www.kkr.mlit.go.jp/river/json/dam.json)',
      license: null,
      cadence: '平日日次 (土日祝除く; 取得は毎日 03:00 UTC = 12:00 JST)',
      what: '近畿地方整備局の 12 国管理ダム (真名川/九頭竜/天ヶ瀬/日吉/室生/青蓮寺/高山/布目/比奈知/一庫/大滝/猿谷) の貯水率のみ。0〜200 % の範囲外の値は取り込まない。',
    },
  }),
  // 高知県水防情報システム ダム諸量現況表 — 11 ダム (和食/永瀬/鎌井谷/鏡/桐見/坂本/
  // 以布利川 [pref] + 早明浦/大渡/中筋川/横瀬川 [国交省]). Pre-generated static
  // Shift_JIS HTML (tableStatusDam_0_1_0_now.html); no servlet call needed.
  // Provides storageRate + storageVolumeM3 + waterLevel + inflow + outflow.
  // Priority 308. Cron at :38.
  defineSource({
    id: 'kochi-bousai',
    priority: 308,
    description: '高知県水防情報システム ダム諸量現況表 — 11 ダム (静的 Shift_JIS HTML)',
    trustedRateBasis: true,
    ingestCron: '38 * * * *',
    details: {
      label: '高知県水防情報',
      upstream:
        '高知県水防情報システム ダム諸量現況表 (suibo-kouho.suibou.pref.kochi.lg.jp/suibou/status/tableStatusDam_0_1_0_now.html)',
      license: null,
      cadence: '時次 (静的 HTML は毎時更新; 取得は毎時 :38)',
      what: '高知県 11 ダム — 県管理 7 (和食/永瀬/鎌井谷/鏡/桐見/坂本/以布利川) + 国交省 4 (早明浦/大渡/中筋川/横瀬川) — の貯水位・貯水量(千m³)・貯水率 (利水容量ベース、なければ有効容量ベース)・流入量・全放流量。',
    },
  }),
  // 高知県公営企業局 発電所集中監視制御Webシステム ダム水文量表 — 物部川の発電専用
  // 吉野/杉田ダム (no other feed covers them). UTF-8 HTML, last 48 hourly rows of
  // 貯水位 + 流入量 + 放流量 + 雨量; no volume or rate. Priority 308. Cron at :44.
  defineSource({
    id: 'kochi-kigyo',
    priority: 308,
    description: '高知県公営企業局 ダム水文量表 — 吉野/杉田ダム (UTF-8 HTML, 時次)',
    ingestCron: '44 * * * *',
    details: {
      upstream:
        '高知県公営企業局 発電所集中監視制御Webシステム ダム水文量表 (210.155.220.59/web/crt17/01/01; 案内: pref.kochi.lg.jp/doc/denki_dam_info/)',
      license:
        '利用許諾・再配布条件の明記なし。サイトの注意事項は「利用者が本サイトで公開している情報を用いて行う行為（編集・加工等した情報を利用することを含む。）について、高知県公営企業局は一切の責任を負うものではありません」。物部川水系治水協定に基づき「試験的に公開」、値は瞬時値で「実際の記録値とは異なります」。',
      cadence: '時次 (直近 48 時間の 1 時間値; 取得は毎時 :44)',
      what: '高知県公営企業局の発電専用 2 ダム (物部川: 吉野/杉田) の貯水位・流入量・放流量・時間雨量。貯水量・貯水率は非公開。両ダムとも本ソース唯一の観測源。',
      label: '高知県公営企業局',
    },
  }),
  // 国土交通省 関東地方整備局 鬼怒川ダム統管 — 4 dams (栃木県:
  // 五十里/川俣/川治/湯西川). realDM.html embeds the 4 dams' values
  // inline as JS arrays (10-min cadence at source). Cron at :17.
  defineSource({
    id: 'ktr-kinu-dam',
    priority: 303,
    description:
      '国土交通省 関東地方整備局 鬼怒川ダム統合管理事務所 — hourly, 4 dams (五十里/川俣/川治/湯西川)',
    ingestCron: '17 * * * *',
    // Hourly real-time sources — flag if older than 3 h.
    freshnessOverrideHours: 3,
    details: {
      upstream:
        '国土交通省 関東地方整備局 鬼怒川ダム統合管理事務所 (ktr.mlit.go.jp/kinudamu/daminfo)',
      license: '国の公式統計値 — 出典明示で再配布可',
      cadence: '時次 (元データは 10 分粒度; 取得は毎時 :17)',
      what: '関東地方整備局 鬼怒川ダム統管直轄 4 ダム (栃木県: 五十里/川俣/川治/湯西川) の貯水位・全流入量・全放流量・累加雨量。',
      label: '鬼怒川ダム統管',
    },
  }),
  // 国土交通省 関東地方整備局 利根川ダム統合管理事務所 — 9 国管理ダム
  // (矢木沢/奈良俣/藤原/相俣/薗原/八ッ場/下久保/草木/渡良瀬貯水池).
  // Single JSON gives all dams' current hourly values. Cron at :20.
  defineSource({
    id: 'ktr-tone-dam',
    priority: 303,
    description: '国土交通省 関東地方整備局 利根川ダム統合管理事務所 — 9 国管理ダム hourly JSON',
    trustedRateBasis: true,
    ingestCron: '20 * * * *',
    details: {
      label: '利根川ダム統合管理事務所',
      upstream:
        '国土交通省 関東地方整備局 利根川ダム統合管理事務所 (www.ktr.mlit.go.jp/tonedamu/teikyo/realtime2/json/E007010.json)',
      license: null,
      cadence: '時次 (JSON は毎時更新; 取得は毎時 :20)',
      what: '同事務所の国管理 9 ダム (矢木沢/奈良俣/藤原/相俣/薗原/八ッ場/下久保/草木/渡良瀬貯水池) の貯水量 (千m³→m³)・貯水率・流入量・全放流量。「5ダム」「9ダム」の合計行は取り込まない; 下久保は shimokubo (10 分値) と重なり、毎正時は本ソースを優先。',
    },
  }),
  // 下松市上下水道局 水源情報 — 県営温見ダム (水位 + 貯水量 + 貯水率 at the stated
  // 「…時現在」; 末武川 is universe-only). Edited about monthly, early in the
  // month. Priority 293. Daily at 02:47 UTC (11:47 JST).
  defineSource({
    id: 'kudamatsu-suido',
    priority: 293,
    description: '下松市上下水道局 水源情報 — 県営温見ダム (水位+貯水量+貯水率, 月次程度)',
    ingestCron: '47 2 * * *',
    details: {
      upstream:
        '下松市上下水道局「水源情報」 (city.kudamatsu.lg.jp/sui-gyoumu/~k-water/damu_001.html)',
      license:
        '利用条件の記載なし (公開情報)。免責事項は「下松市は利用者がこのサイトの情報を用いて行う一切の行為について、責任を負うものではありません」、フッターは「Copyright (C) Kudamatsu City All rights reserved.」。本サイトは観測値 (事実) のみを出典明示で引用。',
      cadence: '月次程度 (月初の「○日0時現在」値; 取得は毎日 11:47 JST)',
      what: '山口県営 温見ダムの水位・貯水量(m³)・貯水率 (総貯水量比)。温見ダムは本ソース唯一の観測源。同ページの末武川ダムは 10 分値の他ソースで取得済みのため未取込。',
      label: '下松市上下水道局',
    },
  }),
  // 熊本県防災情報システム 地方別ダム情報 — 6 ダム (市房/氷川/石打/上津浦/亀川/路木).
  // Shift_JIS JS page; DspDat[] array; 有効貯水量(千m³) / 貯水位 / 全流入量 / 全放流量 /
  // 貯水率(有効容量). 60分更新. Cron at :04 every hour.
  defineSource({
    id: 'kumamoto-bousai',
    priority: 308,
    description: '熊本県防災情報システム 地方別ダム情報 — 6 ダム (Shift_JIS JS, 60分更新)',
    trustedRateBasis: true,
    ingestCron: '4 * * * *',
    details: {
      label: '熊本県 防災情報',
      upstream:
        '熊本県防災情報システム 地方別ダム情報 (www.bousai.pref.kumamoto.jp/Dsp/GmnDspD.exe?52A0)',
      license: null,
      cadence: '60 分更新 (取得は毎時 :04)',
      what: '熊本県 6 ダム (市房/氷川/石打/上津浦/亀川/路木) の貯水位・全流入量・全放流量・有効貯水量(千m³→m³)・貯水率。貯水率は利水容量比を優先し、ない場合は有効容量比 (氷川ダムなど両者が大きく異なるダムがある)。',
    },
  }),
  // 京都府 河川防災情報 ダム諸量現況表 — 6 ダム (大野/畑川 [大野ダム管理] +
  // 天ヶ瀬 [淀川ダム統管] + 日吉/高山/布目 [水資源機構]).
  // Shift_JIS HTML; standard row-per-dam table; volume in ×10³m³.
  // Priority 308. Cron at :42.
  defineSource({
    id: 'kyoto-bousai',
    priority: 308,
    description: '京都府 河川防災情報 ダム諸量現況表 — 6 ダム hourly',
    ingestCron: '42 * * * *',
    details: {
      label: '京都府 河川防災情報',
      upstream:
        '京都府 河川防災情報 ダム諸量現況表 (chisuibousai2.pref.kyoto.jp/bousai/servlet/bousaiweb.servletBousaiTableStatus?dk=4)',
      license: null,
      cadence: '時次 (取得は毎時 :42)',
      what: '京都府の表に載る 6 ダム (大野/畑川 [大野ダム管理]・天ヶ瀬 [淀川ダム統管]・日吉/高山/布目 [水資源機構]) の貯水位 (EL.m)・貯水量 (×10³m³)・流入量・放流量。表中の瀬田洗堰は堰のためダムには割り当てない。',
    },
  }),
  // 九州農政局「管内の農業用ダムの貯水状況」— 7県 59 基。地方農政局で基別
  // テーブルを定期公表しているのはここだけ。PDF、4-9月は毎月1日・15日、
  // 10-3月は毎月1日。大分の 石場/深見/日指/並石 は oita-nourin と重複するので
  // priority で解決する。#28
  defineSource({
    id: 'kyushu-nousei',
    priority: 279,
    description: '九州農政局 管内の農業用ダムの貯水状況 — 59 基 (6県, 月1-2回, 貯水量+貯水率)',
    trustedRateBasis: true,
    ingestCron: '55 4 * * *',
    details: {
      label: '九州農政局',
      upstream:
        '農林水産省 九州農政局「管内の農業用ダムの貯水状況」 (www.maff.go.jp/kyusyu/keikaku/shinko/tyosui/tyosui.html → 当年の PDF)',
      license: null,
      cadence:
        '月 1〜2 回 (4-9 月は毎月 1 日・15 日、10-3 月は毎月 1 日の調査日ベース; 取得は毎日 04:55 UTC)',
      what: '九州 7 県 (福岡/佐賀/長崎/熊本/大分/宮崎/鹿児島) の農業用ダム等 59 基の最新調査日の貯水量(千m³)・貯水率 (利水容量比)。平年貯水量・平年貯水率・対平年比は保存しない。大分の石場/深見/日指/並石は oita-nourin と重複し、そちらを優先。',
    },
  }),
  // 松江市上下水道局 千本ダム・大谷ダム貯水量・貯水率 — daily rows, two months
  // per page, edited on weekday late mornings. Daily at 04:58 UTC (13:58 JST).
  defineSource({
    id: 'matsue-suido',
    priority: 300,
    description: '松江市上下水道局 千本ダム・大谷ダム貯水量・貯水率 — 2 ダム (日次 HTML)',
    ingestCron: '58 4 * * *',
    details: {
      upstream:
        '松江市上下水道局「千本ダム・大谷ダム貯水量・貯水率」 (water.matsue.shimane.jp/shiryo/chosui-list.html)',
      license: '利用条件の記載なし (公開情報) — 出典明示で観測値を引用',
      cadence: '日次 (日付のみ・時刻非公表のため 00:00 JST で記録; 平日更新; 取得は 13:58 JST)',
      what: '松江市の水道専用 2 ダム (千本/大谷) の日別貯水量(m³)・貯水率。当月と前月の全日を毎回取り込み。',
      label: '松江市上下水道局',
    },
  }),
  // M&C鳥取水力発電 発電所・ダム運転情報 — 鳥取県営発電 4 ダム (茗荷谷/三朝調整池/
  // 中津 + 菅沢). One current value per dam (refreshed every minute): 10分間流入量
  // and ゲート放流量 only — the published ダム水位 is a gauge height, not EL.
  // Priority 301 (菅沢 is better covered by 4 other sources). Cron at :32.
  defineSource({
    id: 'mc-tottori-hydro',
    priority: 301,
    description:
      'M&C鳥取水力発電 発電所・ダム運転情報 — 鳥取県営発電 4 ダム (流入量・ゲート放流量, 毎分更新の現在値)',
    ingestCron: '32 * * * *',
    details: {
      upstream: 'M&C鳥取水力発電株式会社 発電所・ダム運転情報 (mchp-k.co.jp/business/list.php)',
      license:
        '利用条件の記載なし (ページ表記は「Copyright © 2021 M&C TOTTORI HYDROPOWER All Right Reserved.」) — 観測値のみを出典明示で掲載',
      cadence: '時次 (ページは毎分更新の現在値; 取得は毎時 :32)',
      what: '鳥取県営発電の運営権者が公開する 4 ダム (茗荷谷/三朝調整池/中津/菅沢) の 10分間流入量とゲート放流量。ダム水位は EL ではない水位計の読みのため保存しない。茗荷谷・三朝・中津は本ソース唯一の観測源。',
      label: 'M&C鳥取水力発電',
    },
  }),
  // 三重県企業庁 水源状況 — 7 ダム, one weekly 「令和…現在」 table (volume + rate);
  // stores 伊坂/山村/菰野調整池, the rest are universe-only. Said to be updated
  // Mondays but seen on a Thursday, so daily at 07:17 UTC (16:17 JST).
  defineSource({
    id: 'mie-kigyo',
    priority: 291,
    description:
      '三重県企業庁 県営水道用水供給事業及び工業用水道事業の水源状況 — 7 ダム (週次 HTML)',
    ingestCron: '17 7 * * *',
    details: {
      upstream:
        '三重県企業庁「県営水道用水供給事業及び工業用水道事業の水源状況」 (pref.mie.lg.jp/D1KIGYO/12674013222.htm)',
      license:
        'サイト表記は「「三重県ウェブサイト」に掲載されている情報（文章、写真、画像、プログラムなど）は、著作権の対象であり、法律によって保護されています。これらの情報について、「私的使用のための複製」や「引用」など著作権法上認められた場合を除き、三重県の許可なく複製、転用等する事は法律で禁止されています」「各ページの記載記事、写真の無断転載を禁じます」。本サイトは観測値 (事実) のみを出典明示で引用。',
      cadence: '週次 (毎週月曜更新・日付のみのため 00:00 JST で記録; 取得は毎日 16:17 JST)',
      what: '三重県企業庁の水源 7 ダム (岩屋/伊坂/山村/中里/菰野調整池/君ヶ野/蓮) の現在貯水量(千m³)・貯水率。保存は他に観測源のない伊坂・山村・菰野調整池のみ。山村の貯水率は企業庁独自の有効貯水量 (1,964 千m³) 比でダム諸元 (2,183 千m³) と基準が異なるため、貯水量のみ保存。',
      label: '三重県企業庁',
    },
  }),
  // 宮城県土木総合情報システム ダム現況表 — 21 ダム (18 県管理 + 3 国管理).
  // Gamen42Servlet: 1 request = all dams. 10 columns: level / 貯水量(10³m³) /
  // inflow / outflow / 貯水率(利水容量). Cron at :06 every hour.
  defineSource({
    id: 'miyagi-kasen',
    priority: 308,
    description: '宮城県土木総合情報システム ダム現況表 — 21 ダム (18 県管理 + 3 国管理), hourly',
    trustedRateBasis: true,
    ingestCron: '6 * * * *',
    details: {
      label: '宮城県 土木総合情報システム',
      upstream:
        '宮城県土木総合情報システム ダム現況表 (www.dobokusougou.pref.miyagi.jp/miyagi/servlet/Gamen42Servlet)',
      license: null,
      cadence: '時次 (最新表と 1 時間前の表を取得; 取得は毎時 :06)',
      what: '宮城県 21 ダム (県管理 18 + 国管理 3: 鳴子/釜房/七ヶ宿) の貯水位・貯水量 (10³m³→m³)・全流入量・全放流量・貯水率 (利水容量)。',
    },
  }),
  // 宮城県 農政部「農業用水の状況」— 主要ダム 17 基 + 主要ため池 9 か所。PDF (2 頁)、
  // 利水容量・貯水量・貯水率・水位・流入/放流量。かんがい期は 1日・15日、それ以外は
  // 月1回の調査日ベースなので日次ポーリングで調査日タイムスタンプへ冪等 UPSERT。
  // 岩堂沢/二ツ石/菅生/宿の沢/村田 と ため池 5 か所が新規。
  defineSource({
    id: 'miyagi-nousei',
    priority: 286,
    description:
      '宮城県 農政部 農業用水の状況 — 主要ダム 17 基 + ため池 9 か所, 月1-2回 (貯水量+貯水率)',
    trustedRateBasis: true,
    ingestCron: '32 5 * * *',
    details: {
      upstream:
        '宮城県 農政部 農村振興課「農業用水の状況」 (pref.miyagi.jp/soshiki/nosonshin/yousui.html → 各回の PDF)',
      license:
        'サイト表記は「『私的使用のための複製』や『引用』など著作権法上認められた場合を除き、無断で複製・転用することはできません」。本サイトは観測値 (事実データ) のみを出典明示のうえ掲載。',
      cadence:
        'かんがい期は毎月 1 日・15 日、それ以外は月 1 回 (調査日 午前9時 ベース; 取得は日次でポーリング)',
      what: '宮城県内の主要ダム 17 基の利水容量・貯水量・貯水率・貯水位・流入量・放流量と、主要ため池 9 か所の満水貯水量・貯水量・貯水率。岩堂沢・二ツ石・菅生・宿の沢・村田と牛野・愛子・嘉太神・川原子・孫沢溜池は他のフィードに載らない。',
      label: '宮城県 農業用水の状況',
    },
  }),
  // 宮崎県河川・砂防水位観測所 — 13 県管理ダム (防災Web servlet, Shift_JIS,
  // no session). 8 columns: level / inflow / outflow (no storage volume).
  // Cron at :55.
  defineSource({
    id: 'miyazaki-bousai',
    priority: 308,
    description: '宮崎県ダム諸量現況表 — 防災Web HTML table, 13 dams, hourly',
    ingestCron: '55 * * * *',
    details: {
      label: '宮崎県 河川・砂防情報',
      upstream:
        '宮崎県河川・砂防水位観測所 ダム諸量現況表 (kasen.pref.miyazaki.jp/bousai/servlet/bousaiweb.servletBousaiTableStatus?sv=3&dk=4&mp=0&no=0&fn=0&pg=1)',
      license: null,
      cadence: '時次 (取得は毎時 :55)',
      what: '宮崎県管理 13 ダム (祝子/沖田/松尾/渡川/立花/長谷/岩瀬/綾南/田代八重/綾北/瓜田/日南/広渡) の貯水位・流入量・全放流量。貯水量・貯水率の列はない。',
    },
  }),
  // mudam tail backfill — monthly increment. mudam publishes confirmed values
  // with a 1-2 year lag, so once or twice a year a new year-block of data
  // becomes available. Running over all 9 districts × 1 year is ~90 min and
  // imports any newly-published rows idempotently. 05 UTC on day 20 = 14:00
  // JST on the 20th, well-spaced from other cron storms.
  // Payload is JSON5 inside {} per graphile-worker convention.
  defineSource({
    id: 'mudam',
    priority: 280,
    description:
      'NILIM ダム諸量データベース (mudam.nilim.go.jp) — daily, ~600 dams, 1-2 year lag (confirmed historical)',
    // Historical: no recurring scan, so it must stay outside the source_universe
    // gate; a dump with no scan would hold the gate open forever and no dam could
    // ever be classified 提供元なし.
    status: 'historical',
    jobs: [{ cron: '0 5 20 * *', task: 'backfill:mudam', payload: '{"district":"all","years":1}' }],
    details: {
      upstream: 'NILIM ダム諸量データベース (mudam.nilim.go.jp)',
      license: '国の公式統計値 — 出典明示で再配布可 (robots.txt allows)',
      cadence: '日次 (1-2 年遅れの確定値; 1998-最新まで)',
      what: '全国 600 ダム × 日次 貯水位・流入量・放流量 (貯水量直接なし)。チャートの歴史的深さ補完用。',
      label: 'NILIM ダム諸量 DB',
    },
  }),
  // 長野県 河川砂防情報ステーション ダム諸量 — 17 県管理ダム (松川/片桐/箕輪/横川/
  // 奈良井/裾花/奥裾花/古谷/内村/豊丘/余地/北山/浅川/水上/小仁熊/湯川/金原).
  // Same JSON pattern as 石川/福島 (sabo-nagano.jp); uses "value"/"level" keys
  // (not "val"/"lvl"); has item_20 storage volume (×1000 m³). Cron at :33.
  defineSource({
    id: 'nagano-kasen',
    priority: 308,
    description: '長野県 河川砂防情報ステーション — 17 県管理ダム hourly JSON',
    ingestCron: '33 * * * *',
    details: {
      label: '長野県 河川砂防情報',
      upstream:
        '長野県 河川砂防情報ステーション ダム諸量 (www.sabo-nagano.jp/dyn/json/dat/pc/{YYYYMMDD}/{YYYYMMDD}_1_dam_60.json)',
      license: null,
      cadence: '時次 (ファイルは毎時再生成; 取得は毎時 :33)',
      what: '長野県管理 17 ダム (松川/片桐/箕輪/横川/奈良井/裾花/奥裾花/古谷/内村/豊丘/余地/北山/浅川/水上/小仁熊/湯川/金原) の貯水位・貯水量 (×1000 m³)・全流入量・全放流量。釜口水門は水門のため除外。',
    },
  }),
  // 長野県企業局 ダム情報 10分諸量 JSON — 高遠 (also kasenbosai) / 菅平 (sole source).
  // Four newest 10-min rows per file, "HH:MM" only; dated from Last-Modified.
  // EL 貯水位 + 全流入量 + 全放流量; 菅平 also 貯水率 (untrusted, no volume).
  // Priority 311 (kasenbosai's 高遠 rows are all NULL; see the task). Cron at :24
  // and :54 — the files are rewritten 12–34 s after each 10-minute mark, so :24
  // reads :20/:10/:00/:50 and :54 reads :50/:40/:30/:20: all six rows an hour.
  // One run an hour would keep only four of the six.
  defineSource({
    id: 'nagano-kigyo',
    priority: 311,
    description:
      '長野県企業局 ダム情報 10分諸量 — 高遠・菅平 (貯水位・全流入量・全放流量, 菅平は貯水率)',
    ingestCron: '24,54 * * * *',
    details: {
      upstream:
        '長野県企業局 ダム情報 (naganoken-kigyokyoku.jp/dam) — /json/{takato,sugadaira}_new.json',
      license:
        '利用条件の記載なし (ページ表記は「Copyright © Nagano Prefecture. All Rights Reserved.」) — 観測値のみを出典明示で掲載',
      cadence:
        '10 分 (元データは 10 分粒度・直近 4 件; 取得は毎時 :24 / :54 の 2 回で全 6 件を保存)',
      what: '長野県企業局管理の高遠ダム・菅平ダムの貯水位 (EL.m)・全流入量・全放流量。菅平は貯水率 (%) も公開 (貯水量は非公開)。菅平は本ソース唯一の観測源。',
      label: '長野県企業局',
    },
  }),
  // 長崎市上下水道局 長崎市ダム貯水量一覧表 — 13 city 水源ダム, one weekly table
  // (月曜 現在, posted the next day). Only 浦上 is written; the rest are covered
  // elsewhere and recorded in the universe. Daily at 06:52 UTC (15:52 JST).
  defineSource({
    id: 'nagasaki-city-suido',
    priority: 293,
    description: '長崎市上下水道局 長崎市ダム貯水量一覧表 — 浦上 (週次 HTML, 貯水量+貯水率)',
    ingestCron: '52 6 * * *',
    details: {
      upstream:
        '長崎市上下水道局 浄水課「長崎市ダム貯水量一覧表」 (www.city.nagasaki.lg.jp/page/53407.html)',
      license:
        'サイト表記は「長崎市ウェブサイトに掲載されている文章、画像等の著作権は長崎市またはコンテンツ提供者に帰属します。これらの情報は、「私的使用のための複製」や「引用」などの著作権法上認められた場合を除き、無断で転用・引用することはできません」。本サイトは観測値 (事実) のみを出典明示で引用。',
      cadence:
        '週次 (月曜の値を翌日掲載, 時刻非公表のため 00:00 JST で記録; 更新が数週間止まることあり; 取得は毎日 15:52 JST)',
      what: '長崎市の水源 13 ダムの一覧表のうち、他ソースにない浦上ダム (水道専用, 再開発前の浦上（元）) の貯水量(m³)・貯水率 (水道有効量 1,900,000 m³ 比)。他のダムは既存ソースでカバー済みのため一覧 (カバレッジ) のみに記録。',
      label: '長崎市上下水道局',
    },
  }),
  // 長崎県河川砂防情報 ダム情報 — 35 ダム (lv / 貯水量(千m³) / 貯水率 / in / out).
  // JSON API (dt_range.json → snapshot URL). 30分更新. Cron at :02 and :32 to
  // catch both the :00 and :30 snapshots each hour.
  defineSource({
    id: 'nagasaki-kasen',
    priority: 308,
    description: '長崎県河川砂防情報 ダム情報 — 35 ダム (JSON, 30分更新)',
    trustedRateBasis: true,
    ingestCron: '2,32 * * * *',
    details: {
      label: '長崎県 河川砂防情報',
      upstream:
        '長崎県河川砂防情報 ダム情報 (dam.pref.nagasaki.jp) — /data/dt_range.json → /data/all/{ym}/{ymd}/all_{ymd}_{hm}_d.json',
      license: null,
      cadence: '30 分更新 (取得は毎時 :02 / :32 で :00 と :30 の両スナップショットを保存)',
      what: '長崎県 35 ダムの貯水位・貯水量(千m³)・貯水率 (利水容量比)・流入量・放流量。',
    },
  }),
  // 奈良県河川情報システム ダム現況表 (PC) — 5 ダム (防災Web Shift_JIS, 10分更新).
  // 岩井川/天理/白川/初瀬/大門. 貯水位/貯水容量/空容量/全流入量/放流量, no 貯水率.
  // Volume = 有効 − 空容量 where 空容量 runs to サーチャージ (all but 大門, which stops at 常時満水位).
  // Cron at :18 every hour.
  defineSource({
    id: 'nara-kasen',
    priority: 308,
    description: '奈良県河川情報システム ダム現況表 — 5 ダム (防災Web Shift_JIS, 10分更新)',
    ingestCron: '18 * * * *',
    details: {
      label: '奈良県 河川情報システム',
      upstream:
        '奈良県河川情報システム ダム現況表 (www.kasen.pref.nara.jp/river_pub/servlet/bousaiweb.servletBousaiTableStatus?…&dk=4…)',
      license: null,
      cadence: '時次 (元データは 10 分更新; 取得は毎時 :18)',
      what: '奈良県管理 5 ダム (岩井川/天理/白川/初瀬/大門) の貯水位・全流入量・放流量と、有効貯水容量 − 空容量で求めた貯水量。貯水率は非公開; 大門は空容量がサーチャージではなく常時満水位基準のため貯水量を保存しない。',
    },
  }),
  // Master refresh
  defineSource({
    id: 'ndi',
    priority: 80,
    description: '国土数値情報 (master location/code)',
    providesObservations: false,
    jobs: [{ cron: '0 3 1 * *', task: 'master:refresh:ndi' }],
    details: {
      upstream: '国土交通省 国土数値情報 (W01: ダム, W05: 河川, W07: 流域メッシュ)',
      license:
        'W01 / W05 / W07 はいずれも「非商用」(旧国土情報利用約款準拠版; W01 は有償刊行物を原典とするため商用利用不可): 出典・加工者を明示のうえ非商用目的で利用し、複製物は再配布しない。本サイトはこれらを加工して作成したダム属性・水系の区分 (一級/二級)・流域界を保持。',
      cadence: '年次 (毎年初旬に最新版へ差し替え)',
      what: 'マスタデータの土台。位置 (緯度経度), 都道府県, 河川, 流域, 総貯水容量, 堤高, 竣工年。水系の一級/二級区分 (W05 区間種別 + 水系域コード)。',
      label: '国土数値情報',
    },
  }),
  // Retired sources stay listed: /sources shows every source_priorities row,
  // and the dam charts still attribute their historical rows here.
  defineSource({
    id: 'niigata-bousai',
    priority: 308,
    description: '新潟県河川防災情報システム — hourly, ~20 県管理ダム (防災Web dk=4 table)',
    status: 'retired',
    trustedRateBasis: true,
    details: {
      upstream: '新潟県河川防災情報システム (doboku-bousai.pref.niigata.jp/kasen)',
      license: '新潟県オープンデータ — 出典明示で再配布可 (推定)',
      cadence: '取得停止 (2026-09-28)',
      what: '取得を停止したソース: robots.txt がサイト全体のクロールを禁止しているため (2026-09-28 確認)。新潟県管理 ~20 ダムの貯水位・貯水率・流入量・全放流量の過去の観測値のみ掲載。',
      label: '新潟県河川防災情報',
    },
  }),
  // 大分県河川情報 ダム諸量現況表 — 10 県管理ダム (防災Web HTML table, Shift_JIS,
  // no session). 10 columns: level / inflow / 貯水量(千m³) / 貯水率 / outflow.
  // Cron at :59.
  defineSource({
    id: 'oita-bousai',
    priority: 308,
    description: '大分県河川情報 ダム諸量現況表 — 防災Web HTML table, 10 dams, hourly',
    trustedRateBasis: true,
    ingestCron: '59 * * * *',
    details: {
      label: '大分県 河川情報',
      upstream:
        '大分県河川情報 ダム諸量現況表 (river.pref.oita.jp/bousai/servlet/bousaiweb.servletBousaiTableStatus?sv=3&dk=4&mp=0&no=0&fn=0&pg=1)',
      license: null,
      cadence: '時次 (取得は毎時 :59)',
      what: '大分県管理 10 ダム (安岐/行入/青江/野津/黒沢/床木/稲葉/玉来/芹川/北川) の貯水位・流入量・貯水量(千m³→m³)・貯水率・放流量。',
    },
  }),
  // 大分県 農林水産部 農地・農村整備課「農業用ダム貯水率一覧」— 農業用ダム 21 基
  // (石山/鍋倉/久木野尾/乙見/末広/中ノ川/石場/大舞 ほか)。土木部の
  // ingest:oita-bousai とは対象ダムがほぼ重ならない。PDF 1 テーブル、
  // 有効貯水量・現貯水量・貯水率。かんがい期 (4-9月) は月2回、それ以外は月1回の
  // 調査日ベースなので、fukushima-nourin と同じく日次ポーリングで拾う
  // (調査日タイムスタンプへの冪等 UPSERT)。#27
  defineSource({
    id: 'oita-nourin',
    priority: 282,
    description:
      '大分県 農林水産部 農業用ダム貯水率一覧 — 農業用ダム 21 基, 月1-2回 (貯水量+貯水率)',
    trustedRateBasis: true,
    ingestCron: '35 4 * * *',
    details: {
      label: '大分県 農業用ダム',
      upstream:
        '大分県 農林水産部 農地・農村整備課「農業用ダム貯水率一覧」 (www.pref.oita.jp/site/oitanougyouyoudamuchosuiritsuitiran/ → 各回の PDF)',
      license: null,
      cadence:
        'かんがい期 (4-9月) は月 2 回、それ以外は月 1 回 (調査日ベース; 取得は日次 04:35 UTC)',
      what: '大分県の農業用ダム 21 基 (石山/鍋倉/久木野尾/乙見/末広/中ノ川/石場/大舞 ほか) の現貯水量 (千m³) と貯水率。貯水率が 現貯水量 / 有効貯水量 と一致しない行 (大谷/大蘇) は取り込まない。',
    },
  }),
  // おかやま防災ポータル — ~15 県管理ダム (JSON feed, 30分更新). A pointer
  // fetch yields the freshest snapshot file with every dam's values. Cron at
  // :21 every hour, spaced from the other prefectural sources.
  defineSource({
    id: 'okayama-bousai',
    priority: 309,
    description: 'おかやま防災ポータル — hourly, ~15 県管理ダム (JSON feed, 30分更新)',
    trustedRateBasis: true,
    ingestCron: '21 * * * *',
    details: {
      upstream: 'おかやま防災ポータル (bousai.pref.okayama.jp)',
      license: '岡山県オープンデータ — 出典明示で再配布可 (推定)',
      cadence: '時次 (元データは 30 分粒度; 取得は毎時 :21)',
      what: '岡山県管理 ~15 ダム (旭川/鳴滝/河平/三室川/黒木/香々美/久賀/津川/黒谷/鬼ヶ岳/大佐/日笠/槙谷/楢井 ほか) の貯水位・有効貯水量・貯水率・流入量・全放流量。',
      label: 'おかやま防災ポータル',
    },
  }),
  // 沖縄県企業局 — 倉敷ダム (県管理) / 山城ダム (企業局管理) 日次 (CSV, 午前0時時点).
  // Source: www.eb.pref.okinawa.jp/js/chart/dam-youryou.csv
  // 5-row CSV with storage volume (千m³) and rate (%) per group.
  // Priority 302. Cron daily at 03:00 UTC = 12:00 JST.
  defineSource({
    id: 'okinawa-eb',
    priority: 302,
    description: '沖縄県企業局 — 倉敷・山城ダム日次 (貯水量+貯水率)',
    ingestCron: '0 3 * * *',
    details: {
      label: '沖縄県企業局',
      upstream: '沖縄県企業局 ダム貯水量 CSV (www.eb.pref.okinawa.jp/js/chart/dam-youryou.csv)',
      license: null,
      cadence: '日次 (午前 0 時時点の値; 取得は毎日 12:00 JST)',
      what: '倉敷ダム (県管理)・山城ダム (企業局管理) の貯水量(千m³)・貯水率。同じ CSV の国管理 9 ダムの合計値は保存しない。',
    },
  }),
  // 大村市上下水道局 ダム（水源）情報 — 池田貯水池 written (the 萱瀬 row is the city's
  // share of a dam kasenbosai carries: universe only). 利水貯水量 + 利水貯水率 at
  // 07:00 JST. Priority 292. Daily at 01:41 UTC (10:41 JST).
  defineSource({
    id: 'omura-suido',
    priority: 292,
    description:
      '大村市上下水道局 ダム（水源）情報 — 池田貯水池 (日次 07:00, 利水貯水量+利水貯水率)',
    trustedRateBasis: true,
    ingestCron: '41 1 * * *',
    details: {
      upstream: '大村市上下水道局「ダム（水源）情報」 (omura-waterworks.jp/water/)',
      license:
        '利用条件の記載なし (サイトに著作権・利用規約のページなし; フッターは「Copyright (C) 大村市上下水道局 All Rights Reserved.」) — 出典明示で観測値 (事実) のみを引用',
      cadence: '日次 (07:00 JST 値; 取得は 10:41 JST)',
      what: '池田貯水池 (池田（再）) の現在利水貯水量(m³)・利水貯水率 (利水貯水量 200,000 m³ 比)。池田は本ソース唯一の観測源。同表の萱瀬ダムは大村市水道用水分 (1,017,000 m³) のみの値で、ダム全体は既存ソースで取得済みのため一覧 (カバレッジ) のみに記録。',
      label: '大村市上下水道局',
    },
  }),
  // 大阪府河川防災情報 — 3 県管理ダム (安威川/箕面川/狭山池). Single JSON fetch;
  // displayDt is YYYYMMDDHHMM JST. Cron at :31.
  defineSource({
    id: 'osaka-bousai',
    // 308, one below kasenbosai (310): 川の防災情報 publishes all three dams
    // with 貯水位/流入量/放流量 on top of the volume this feed carries, so it
    // should win the chart. At an equal 310 the chart source for 安威川/箕面川/
    // 狭山池 was whichever row the planner returned first.
    priority: 308,
    description: '大阪府河川防災情報 — hourly, 3 県管理ダム (JSON feed, 1分更新)',
    ingestCron: '31 * * * *',
    details: {
      upstream: '大阪府河川防災情報 (osaka-kasen-portal.net/suibou/publicdata/choryuryo.json)',
      license: '公開情報 — 出典明示で再配布可',
      cadence: '時次 (元データは 1 分更新; 取得は毎時 :31)',
      what: '大阪府管理 3 ダム (安威川/箕面川/狭山池) の有効貯水量(m³)・貯水率。水位・流量は非公開。',
      label: '大阪府河川防災情報',
    },
  }),
  // 国土交通省 九州地方整備局 竜門ダム管理所 — 竜門ダム (佐田川水系, 福岡/40).
  // PHP key-value endpoint (data.php?key=); 6 keys fetched in parallel: time /
  // ryunyu / houryu / chosuiryo / chosuii / chosuiritsu. Full data: storage +
  // rate + level + inflow + outflow. Cron at :24.
  defineSource({
    id: 'qsr-ryumon-dam',
    priority: 303,
    description: '国土交通省 九州地方整備局 竜門ダム管理所 — 竜門ダム (佐田川水系, Fukuoka)',
    ingestCron: '24 * * * *',
    details: {
      label: '竜門ダム管理所',
      upstream:
        '国土交通省 九州地方整備局 竜門ダム管理所 (www.qsr.mlit.go.jp/ryumon/bousai/kkc_out/ryumon/data.php)',
      license: null,
      cadence: '時次 (取得は毎時 :24)',
      what: '竜門ダム (佐田川水系, 福岡県) 1 ダムの貯水位・貯水量 (千m³→m³)・貯水率・全流入量・全放流量。data.php?key= の 6 キーを並列取得。',
    },
  }),
  // 国土交通省 九州地方整備局 筑後川ダム統合管理事務所 — 2 国管理ダム (筑後川水系, 大分/44).
  // 松原ダム / 下筌ダム. Single HTML page with 2 tables (one per dam); one data
  // row each. level + inflow + 全放流量 + hourly rain (no storage). Cron at :26.
  defineSource({
    id: 'qsr-toukan-dam',
    priority: 303,
    description:
      '国土交通省 九州地方整備局 筑後川ダム統合管理事務所 — 2 dams: 松原/下筌 (筑後川水系, Oita)',
    ingestCron: '26 * * * *',
    details: {
      label: '筑後川ダム統管',
      upstream:
        '国土交通省 九州地方整備局 筑後川ダム統合管理事務所 (www.qsr.mlit.go.jp/toukan/bousaijouhou.php)',
      license: null,
      cadence: '時次 (毎時 00 分更新; 取得は毎時 :26)',
      what: '筑後川水系の国管理 2 ダム (松原/下筌, 大分県) の貯水位・流入量・全放流量 (ゲート放流量 + 発電使用水量)・時間雨量。貯水量・貯水率は掲載なし。',
    },
  }),
  // 国土交通省 九州地方整備局 鶴田ダム管理所 — 鶴田ダム (川内川水系, 鹿児島/46).
  // EUC-JP HTML table, 10分更新; type=2 endpoint, 7 cols. Cron at :22.
  defineSource({
    id: 'qsr-turuta-dam',
    priority: 303,
    description: '国土交通省 九州地方整備局 鶴田ダム管理所 — 鶴田ダム (川内川水系, Kagoshima)',
    trustedRateBasis: true,
    ingestCron: '22 * * * *',
    details: {
      label: '国交省 鶴田ダム',
      upstream:
        '国土交通省 九州地方整備局 鶴田ダム管理所 (www.qsr.mlit.go.jp/turuta/cgi-bin/ajax_gethtml.cgi?type=2)',
      license: null,
      cadence: '10分更新 (毎時 :22 に取得)',
      what: '鶴田ダム (川内川水系, 鹿児島県) の雨量・貯水量 (千m³)・流入量・放流量・貯水率。',
    },
  }),
  // 新潟県 佐渡地域振興局「農業用ダムの貯水量情報」— 県営農業用ダム 7 基
  // (羽茂/竹田川/小倉川/藤津川/新穂/新穂第2/佐和田)。ダム別の静的 HTML、
  // 貯水量 + 貯水率。調査日ベースで不定期 (月1-2回) なので日次ポーリング。
  defineSource({
    id: 'sado-nourin',
    priority: 281,
    description:
      '新潟県 佐渡地域振興局 農業用ダムの貯水量情報 — 県営農業用ダム 7 基, 月1-2回 (貯水量+貯水率)',
    trustedRateBasis: true,
    ingestCron: '54 5 * * *',
    details: {
      upstream:
        '新潟県 佐渡地域振興局 農林水産振興部「【佐渡】農業用ダムの貯水量情報」 (pref.niigata.lg.jp/site/sado-nourinsuisan-nouson/122000000.html → ダム別ページ)',
      license:
        'サイト表記は「『私的使用』または『引用』など著作権法上認められた行為として適切な方法で利用する場合を除き、新潟県に無断で転載、複製…をすることはできません」。本サイトは観測値 (事実データ) のみを出典明示のうえ掲載。',
      cadence:
        'かんがい期に月 1〜2 回程度 (調査日 (令和N年M月D日時点) ベース; 取得は日次でポーリング)',
      what: '佐渡の県営農業用ダム 7 基 (羽茂・竹田川・小倉川・藤津川・新穂・新穂第2・佐和田) の貯水量と貯水率 (各ページの有効貯水量に対する整数 %)。',
      label: '佐渡 農業用ダム',
    },
  }),
  // 佐賀県河川砂防情報システム ダム現況表 — 19 県管理ダム (岸川/庭木/繁昌/天ヶ瀬/
  // 平木場/伊岐佐/都川内/井手口川/竜門/有田/古木場/本部/矢筈/狩立日ノ峯/中木庭/
  // 岩屋川内/横竹/深浦/河内). Transposed Shift_JIS HTML table; 3 pages (7+7+5
  // dams) fetched in parallel. Dam names are column headers (not row labels).
  // Cron at :40.
  defineSource({
    id: 'saga-bousai',
    priority: 308,
    description: '佐賀県河川砂防情報システム ダム現況表 — 19 県管理ダム hourly (3-page Shift_JIS)',
    trustedRateBasis: true,
    ingestCron: '40 * * * *',
    details: {
      label: '佐賀県 河川砂防情報',
      upstream:
        '佐賀県河川砂防情報システム ダム現況表 (kasen.pref.saga.lg.jp/river_pub/servlet/bousaiweb.servletBousaiTableStatus?dk=4&sv=3&pg=1〜3)',
      license: null,
      cadence: '時次 (取得は毎時 :40、3 ページを並列取得)',
      what: '佐賀県管理 19 ダム (岸川/庭木/繁昌/天ヶ瀬/平木場/伊岐佐/都川内/井手口川/竜門/有田/古木場/本部/矢筈/狩立日ノ峯/中木庭/岩屋川内/横竹/深浦/河内) の貯水位 (EL.m)・全流入量・全放流量。一部のダムは貯水量(千m³)・貯水率も。',
    },
  }),
  // 埼玉県 川の防災情報 ダム諸量 — 9 ダム (合角/有間/権現堂調節池 [県管理] +
  // 渡良瀬遊水地/二瀬/荒川第一調節池/浦山/滝沢/下久保 [国管理]).
  // UTF-8 CSV; timestamp YYYYMMDDHHmm JST; volume in 千m³; missing as "c"/"*".
  // Priority 308. Cron at :44.
  defineSource({
    id: 'saitama-suibo',
    priority: 308,
    description: '埼玉県 川の防災情報 ダム諸量 — 9 ダム hourly CSV',
    ingestCron: '44 * * * *',
    details: {
      label: '埼玉県 川の防災情報',
      upstream:
        '埼玉県 川の防災情報 ダム諸量 (suibo-river.pref.saitama.lg.jp/hyoujidata/dinfo.csv)',
      license: null,
      cadence: '時次 (取得は毎時 :44)',
      what: '埼玉県の 9 施設 (県管理: 合角/有間/権現堂調節池、国管理: 渡良瀬遊水地/二瀬/荒川第一調節池/浦山/滝沢/下久保) の貯水位・貯水量 (千m³→m³)・流入量・放流量。CSV の欠測は「c」「*」。',
    },
  }),
  // 山王海土地改良区「ダムの状況」— 山王海 (再)・葛丸 (東北農政局) の貯水量 (万㎥)。
  // 値はページ内スクリプト、調査日は WordPress REST の modified_gmt (JST 日付
  // 00:00)。毎週月曜朝に更新されるので 03:22 UTC (12:22 JST) の日次。
  defineSource({
    id: 'sannoukai',
    priority: 277,
    description: '山王海土地改良区 ダムの状況 — 山王海ダム・葛丸ダム貯水量 (週次 HTML)',
    ingestCron: '22 3 * * *',
    details: {
      upstream: '山王海土地改良区「ダムの状況」 (sannoukai.jp/condition/)',
      license:
        '利用条件の記載なし (サイト表記は「©2017-2025 Sannoukai LID foundation」のみ)。本サイトは観測値 (事実データ) のみを出典明示のうえ掲載。',
      cadence:
        '週次 (「毎週月曜日に更新します。」; 調査日はページの更新日 (WordPress の modified) の 00:00 JST で記録; 取得は毎日 12:22 JST)',
      what: '山王海ダム・葛丸ダム (東北農政局の国営親子ダム, 山王海土地改良区管理) の貯水量(万m³)。ページの貯水率は総貯水容量に対する画面上の計算値のため保存しない。',
      label: '山王海土地改良区',
    },
  }),
  // 佐世保市水道局 水道用貯水池の貯水状況表 — 6 ダム (山の田/菰田/川谷/相当/転石/
  // 下の原), daily PDF of the 00:00 JST readings (link discovered each run).
  // 01:54 + 07:54 UTC (10:54 / 16:54 JST) to catch a late upload.
  defineSource({
    id: 'sasebo-suido',
    priority: 300,
    description: '佐世保市水道局 水道用貯水池の貯水状況表 — 6 ダム (日次 PDF, 貯水量+貯水率)',
    trustedRateBasis: true,
    ingestCron: '54 1,7 * * *',
    details: {
      upstream:
        '佐世保市水道局「佐世保市水道用貯水池の貯水状況表」 (city.sasebo.lg.jp/suidokyoku/suisou/chosuiritsu.html の日次 PDF)',
      license:
        'サイト表記は「当サイトに掲載している文字、写真、イラストやデザインといった情報の著作権は、私たち又は原権利者に帰属します。私的使用又は引用等著作権法上認められている行為を除き、無断で転載等を行うことはできません。引用を行う際は、適宜の方法により、必ず出所を明示してください」。本サイトは観測値 (事実) のみを出典明示で引用。',
      cadence: '日次 (毎日 00:00 JST 値, 土日含む; 取得は 10:54 / 16:54 JST)',
      what: '佐世保市水道局 6 ダム (山の田/菰田/川谷/相当/転石/下の原) の現在貯水量(m³)・貯水率 (水道有効貯水量比)。水位・流量は非公開。',
      label: '佐世保市水道局',
    },
  }),
  // 滋賀県土木防災 (mobile pages; robots.txt disallows /dam/, allows /mobile/) —
  // 8 dams, the latest 10-minute value + six hourly rows per station. Cron at
  // every hour :07 re-upserts the six-hour window for self-healing.
  defineSource({
    id: 'shiga-bousai',
    priority: 308,
    description:
      '滋賀県土木防災情報システム (mobile) — hourly, 8 dams (青土/日野川/永源寺/野洲川/蔵王/宇曽川/姉川/石田川)',
    ingestCron: '7 * * * *',
    // Hourly real-time sources — flag if older than 3 h.
    freshnessOverrideHours: 3,
    details: {
      upstream:
        '滋賀県土木防災情報システム モバイル版 ダム観測情報 (shiga-bousai.jp/mobile/dam/dam_select.php)',
      license: '滋賀県オープンデータ — 出典明示で再配布可 (推定)',
      cadence: '時次 (最新 10 分値 + 直近 6 時間の 1 時間値; 取得は毎時 :07)',
      what: '滋賀県 8 ダム (青土/日野川/永源寺/野洲川/蔵王/宇曽川/姉川/石田川) の貯水位・流入量・放流量・60分間雨量。',
      label: '滋賀県土木防災',
    },
  }),
  // 島根県防災Web — 14 県管理ダム (布部/山佐/三瓶/波積/八戸/浜田/第二浜田/大長見/
  // 御部/益田川/笹倉/大峠/銚子/美田). Same Remix SPA framework as 広島/鳥取県防災Web;
  // pointer + list JSON; storage in 千m³. 国直轄 (尾原/志津見) also appear but
  // cgr-mlit-dam (priority 304) wins preferredSource for those. Cron at :37.
  // 島根県水防情報システム (suibou-shimane.jp) — 19 ダム, one dam60.json per JST
  // day with every hourly snapshot; each run re-reads yesterday's and today's
  // file because the copy served at :37 lags ~2 h. Storage in 千m³. Cron at :37.
  defineSource({
    id: 'shimane-bousai',
    priority: 313,
    description: '島根県水防情報システム (suibou-shimane.jp) — 19ダム hourly JSON',
    trustedRateBasis: true,
    ingestCron: '37 * * * *',
    details: {
      upstream:
        '島根県水防情報システム (www.suibou-shimane.jp) — /dyn/dps/json/{YYYYMMDD}/dam60.json',
      license:
        '利用条件に再配布の定めなし (「利用における注意事項」: 無人観測所の速報値で異常値を含み得る)',
      cadence: '時次 (60 分値; 取得は毎時 :37、前日分と当日分の全時刻を毎回読み直し)',
      what: '島根県 19 ダム — 土木部 14 (布部/山佐/三瓶/波積/八戸/浜田/第二浜田/大長見/御部/益田川/笹倉/大峠/銚子/美田)、農林水産部 3 (清瀧/津田川/嵯峨谷)、三成/木都賀 — の貯水位・貯水量(千m³)・利水貯水率(洪水期/非洪水期)・流入量・全放流量。',
      label: '島根県水防情報システム',
    },
  }),
  // 水資源機構 利根川上流総合管理所 下久保ダム — 1 dam (群馬/埼玉境). JSON feed
  // (UTF-8-BOM), 10分更新. Upgrades jwa-toneara (daily, priority 296) → hourly for
  // 下久保ダム. Priority 297. Cron at :49.
  defineSource({
    id: 'shimokubo',
    priority: 297,
    description: '水資源機構 利根川上流総合管理所 下久保ダム 実時計 (10分間隔)',
    trustedRateBasis: true,
    ingestCron: '49 * * * *',
    details: {
      label: 'JWA 下久保ダム',
      upstream:
        '水資源機構 利根川上流総合管理所 下久保ダム (shimokubo.kannet.ne.jp/data/table.json)',
      license: null,
      cadence: '10 分更新 (最新の 10 分値; 取得は毎時 :49)',
      what: '下久保ダム (群馬/埼玉県境) の貯水位・有効容量内貯水量(千m³→m³)・有効容量内貯水率・全流入量・全放流量。jwa-toneara (日次) を時次に格上げ。',
    },
  }),
  // 下関市上下水道局 水源状況 — 湯の原ダム written (木屋川 and the combined 内日貯水池
  // recorded in the universe only). 貯水量 + 貯水率 at 00:00 JST, edited a few
  // times a week during the day. Daily at 07:46 UTC (16:46 JST).
  defineSource({
    id: 'shimonoseki-suido',
    priority: 293,
    description: '下関市上下水道局 水源状況 — 湯の原ダム (貯水量+貯水率, 当日0時, 週数回更新)',
    universeEnumerable: false,
    trustedRateBasis: true,
    ingestCron: '46 7 * * *',
    // The 水源状況 page is a 渇水 notice, taken down when the drought ends
    // (HTTP 404 on 2026-09-28; see migration 0151).
    freshnessOverrideHours: null,
    details: {
      upstream:
        '下関市上下水道局「水源状況についてお知らせします」 (city.shimonoseki.lg.jp/site/water/5617.html)',
      license:
        'サイト表記は「当ホームページの内容の全部または一部については、私的使用のための複製や引用等著作権法上認められた行為として、出所を明示することにより、複製・引用・転載できます。ただし、「無断転載禁止」などの注記があるものについては、それに従ってください」。本サイトは観測値 (事実) のみを出典明示で引用。',
      cadence: '週数回 (当日 00:00 JST 値, 日中に更新; 取得は 16:46 JST)',
      what: '下関市の水源 3 施設の貯水量(m³)・貯水率 (洪水期は制限後の満水量比)。湯の原ダムは新規カバレッジ。木屋川ダムは川の防災情報/山口県が 10 分値で提供済みのため未取込、内日貯水池は 2 ダム (内日第1/第2) の合算値のため未紐付け。',
      label: '下関市上下水道局',
    },
  }),
  // 上田市塩田平土地改良区 沢山池の状況図 — one CSV line (貯水位, 貯水量, 貯水率,
  // 流入量, 時間雨量) re-uploaded a minute past every 10-minute mark; stamped at
  // its Last-Modified floored to 10 min. Hourly at :05.
  defineSource({
    id: 'shioda-sayamaike',
    priority: 285,
    description:
      '上田市塩田平土地改良区 沢山池の状況図 — 沢山池 (貯水位・貯水量・貯水率・流入量, 10 分毎)',
    ingestCron: '5 * * * *',
    details: {
      upstream:
        '上田市塩田平土地改良区 (水土里ネット塩田平)「沢山池の状況図」 (midorinet-shioda.or.jp/reservoir/sayamaike/ — data/SFTP.csv)',
      license:
        '利用条件の記載なし (公開情報)。各ページのフッターは「copyright © 上田市塩田平土地改良区 All Rights Reserved.」。本サイトは観測値 (事実) のみを出典明示で引用。',
      cadence:
        '10 分毎 (CSV は毎 10 分の約 1 分後に更新され時刻を持たないため、更新時刻を 10 分単位に切り捨てて記録; 取得は毎時 :05)',
      what: '長野県上田市の農業用ため池 沢山池の貯水位(E.L.m)・貯水量(m³)・貯水率 (総貯水量比の整数 %)・全流入量・時間雨量。放流量は 2026-03-13 以降ページに表示されていないため取り込まない。沢山池は本ソース唯一の観測源。',
      label: '塩田平土地改良区',
    },
  }),
  defineSource({
    id: 'shizuoka-bousai',
    priority: 308,
    description: '静岡県 SIPOS ダム',
    status: 'retired',
    trustedRateBasis: true,
    details: {
      upstream: '静岡県土木総合防災情報システム SIPOS (sipos.pref.shizuoka.jp)',
      license: '利用条件は未確認 — 過去の観測値のみを出典明示で掲載',
      cadence: '取得停止 (2026-09-28)',
      what: '取得を停止したソース: robots.txt が /index.html 以外のクロールを禁止しているため (2026-09-28 確認)。静岡県 6 ダム (奥野/太田川/都田川/青野大師/大倉川/長島) の貯水位・貯水量・貯水率・流入量・放流量の過去の観測値のみ掲載。',
      label: '静岡県 SIPOS',
    },
  }),
  // 国土交通省 四国地方整備局 肱川ダム統合管理事務所 — 野村・鹿野川ダム (肱川水系, 愛媛/38).
  // www1.river.go.jp CGI (EUC-JP HTML + IFRAME), 10分更新; 2 dams, 4 HTTP requests.
  // Cron at :23.
  defineSource({
    id: 'skr-hiji-dam',
    priority: 303,
    description: '国土交通省 四国地方整備局 肱川ダム統合管理事務所 — 野村・鹿野川ダム (Ehime)',
    trustedRateBasis: true,
    ingestCron: '23 * * * *',
    details: {
      label: '国交省 肱川ダム統管',
      upstream:
        '国土交通省 四国地方整備局 肱川ダム統合管理事務所 (www1.river.go.jp/cgi-bin/DspDamData.exe)',
      license: null,
      cadence: '10分更新 (毎時 :23 に取得; 2 ダムで 4 リクエスト)',
      what: '肱川水系 2 ダム (野村/鹿野川, 愛媛県) の雨量・貯水量 (千m³)・流入量・放流量・貯水率。',
    },
  }),
  // 底原ダム管理システム (cosmos.ne.jp/~sokobaru) — 石垣島 底原/真栄里/石垣ダム (沖縄/47),
  // no other live feed. Shift_JIS i-mode pages, one per reading, 13 hourly rows each:
  // 貯水位 + 総貯水量(千m3, stored less 堆砂 150 when the printed 貯水率 ties) + 貯水率 +
  // 流入量 + 放流量 (底原; 真栄里/石垣 level + outflow). Priority 291. Cron at :05.
  defineSource({
    id: 'sokobaru-dam',
    priority: 291,
    description: '底原ダム管理システム — 石垣島 底原/真栄里/石垣ダム (時次 HTML, 直近 13 時間)',
    ingestCron: '5 * * * *',
    details: {
      upstream: '底原ダム管理システム (www.cosmos.ne.jp/~sokobaru/index.html)',
      license:
        '利用条件・運営者の記載なし (ページは「底原ダム 管理システム MainMenu」と各水文量の表のみ; robots.txt なし) — 観測値のみを出典明示で掲載',
      cadence: '時次 (直近 13 時間の毎正時値, ページは数分ごとに再生成; 取得は毎時 :05)',
      what: '石垣島の 3 ダム (底原/真栄里/石垣) の貯水位 (EL.m)・放流量。底原は貯水率・全流入量と、総貯水量(千m³) から堆砂容量 150 千m³ (ダム諸元の総 − 有効; 公表貯水率と一致する時刻のみ) を差し引いた有効貯水量も。真栄里・石垣は貯水率を公表せず総貯水量の基準を確かめられないため貯水量は保存しない。3 ダムとも本ソース唯一の観測源。同じメニューの二又堰・平喜名堰は取水堰のため取り込まない。',
      label: '底原ダム管理システム',
    },
  }),
  // 須恵町上下水道課 貯水率 — 須恵ダム (and 3 ponds outside the master), whole-percent
  // 貯水率 only, dated by the page's 更新日, re-issued about monthly. Priority 293.
  // Daily at 06:17 UTC (15:17 JST).
  defineSource({
    id: 'sue-suido',
    priority: 293,
    description: '須恵町上下水道課 貯水率 — 須恵ダム (月次, 貯水率のみ)',
    ingestCron: '17 6 * * *',
    // Re-issued about monthly (更新日 2026-09-01 carries the 8月 figures) and
    // stamped with that 更新日; a late month plus lag. One stamp alone would get
    // 3 × the daily poll.
    freshnessOverrideHours: 45 * 24,
    details: {
      upstream:
        '須恵町上下水道課「貯水率」 (town.sue.fukuoka.jp/soshiki/jogesuido/jogesuido/josuido/1394.html)',
      license:
        'サイト表記は「須恵町公式ウェブサイトに掲載している内容（写真・イラスト・音声・動画及び記事、その他のデータ）の著作権は須恵町に帰属します。（一部の画像等の著作権は、原著作者が所有しています）」「須恵町公式ウェブサイトの内容について、「私的使用のための複製」や「引用」など著作権法上認められた場合を除き、無断で複製・転用することはできません。」。本サイトは観測値 (事実) のみを出典明示で引用。',
      cadence:
        '月次程度 (「現在の貯水率」, 日付はページの更新日・00:00 JST で記録; 取得は毎日 15:17 JST)',
      what: '須恵町の水道水源 須恵ダムの貯水率 (整数 %) のみ。貯水量・容量は非公表のため保存せず、サイト上の貯水率表示はない (観測系列とカバレッジのみ)。中柱田貯水池・旧男鳥溜池・新男鳥溜池は台帳 (国土数値情報) にないため一覧のみに記録。',
      label: '須恵町上下水道課',
    },
  }),
  // Backfill only, opt-in: enqueue backfill:suimon:enqueue with add_job rather than
  // a fixed cron, so we do not keep hammering the upstream when there is nothing new.
  defineSource({
    id: 'suimon',
    priority: 90,
    description: '水文水質DB (historical MLIT)',
    status: 'historical',
    universeEnumerable: false,
    details: {
      label: '水文水質DB',
      upstream: '国土交通省 水文水質DB (www1.river.go.jp/sample/?type=DamReservoir&id=)',
      license: null,
      cadence:
        '過去データの取込 (cron なし・手動でダム×年の取込を投入; 1 回 5 件ずつ、5 秒間隔で取得)',
      what: '台帳で水文水質DB の観測所 ID が紐付いたダムの過去データ (既定で 2014 年〜前年) をダム×年ごとの CSV で取得し、貯水位・貯水量・貯水率・流入量・放流量・雨量を取り込む。',
    },
  }),
  // 兵庫県 昭和池防災情報管理システム — 昭和池 (加東市, NDI 1539). public/DamData.jsp,
  // one 10分更新 Windows-31J snapshot: 貯水位 + 貯水量(m³) + 流入量 + 時間雨量 (越流量
  // is spill only, integer 貯水率 left to the trigger). Priority 299. Cron at :23.
  defineSource({
    id: 'syowaike',
    priority: 299,
    description: '兵庫県 昭和池防災情報管理システム — 昭和池 (加東市, 10分更新 テレメータ HTML)',
    ingestCron: '23 * * * *',
    details: {
      upstream:
        '兵庫県 昭和池防災情報管理システム「昭和池 テレメータデータ」 (syowaike.jp/public/DamData.jsp)',
      license:
        '利用条件の記載なし (トップページ「利用における注意事項」は「観測機器の故障や通信異常等による異常値がそのまま表示されてしまう可能性があります」「利用者の皆様が当ホームページの情報を用いて行う一切の行為について兵庫県は何ら責任を負うものではありません」のみ) — 観測値のみを出典明示で掲載',
      cadence: '時次 (元データは 10 分更新の最新値のみ; 取得は毎時 :23)',
      what: '昭和池 (兵庫県加東市) の貯水位・貯水量(m³)・流入量・時間雨量。貯水率は整数表示のため保存せず貯水量と有効貯水容量から算出。越流量は洪水吐からの越流のみで取水放流を含まないため放流量として保存しない。',
      label: '昭和池',
    },
  }),
  // 兵庫県 丹波農林振興事務所 ダムテレメータ — 6 dams (鍔市/八幡谷/藤岡/佐仲/黒石/大杉).
  // Tanba area dams; Shift_JIS HTML single-latest-value display. PSNO=2,4 currently
  // offline (0000/00/00 timestamps). Storage volume in direct m³ (not 千m³).
  // URL: tndam.pref.hyogo.lg.jp/dam/DamData.jsp?PSNO={1-6}. Cron at :53.
  defineSource({
    id: 'tndam-hyogo',
    priority: 308,
    description: '兵庫県丹波農林振興事務所 ダムテレメータ — 6 dams (Tanba area), hourly',
    ingestCron: '53 * * * *',
    details: {
      label: '兵庫県 丹波ダムテレメータ',
      upstream:
        '兵庫県 丹波農林振興事務所 ダムテレメータ (tndam.pref.hyogo.lg.jp/dam/DamData.jsp?PSNO={1-6})',
      license: null,
      cadence: '最新値のみ表示 (時系列なし; 取得は毎時 :53)',
      what: '丹波地域の 6 ダム (鍔市/八幡谷/藤岡/佐仲/黒石/大杉) の貯水位・貯水量 (m³ 表記、千m³ ではない)・貯水率・流入量・放流量・時間雨量。八幡谷 (PSNO=2)・佐仲 (PSNO=4) は現在停止中 (更新時刻 0000/00/00)。',
    },
  }),
  // 栃木県河川水位・雨量情報システム — 7観測所 (BODIK ダム諸量 NGSI-v2 CSV,
  // CC-BY 4.0, 10分更新). dateObserved is ISO UTC, waterStorage in 千m³.
  // Cron at :27.
  defineSource({
    id: 'tochigi-bodik',
    priority: 311,
    description:
      '栃木県河川水位・雨量情報システム — BODIK ダム諸量 NGSI-v2 CSV (CC-BY 4.0, 10分更新, 7観測所)',
    ingestCron: '27 * * * *',
    details: {
      upstream:
        '栃木県河川水位・雨量情報システム ダム諸量 (data.bodik.jp/dataset/090000_river_dam_parameter)',
      license: 'CC-BY 4.0 — 出典明示で再配布可',
      cadence: '時次 (元データは 10 分粒度; 取得は毎時 :27)',
      what: '栃木県管理 7 ダム (寺山/塩原/西荒川/東荒川/三河沢/中禅寺/松田川) の貯水位・貯水量(m³)・全流入量・全放流量。BODIK NGSI-v2 CSV。',
      label: '栃木県オープンデータ',
    },
  }),
  // 徳島県河川砂防水位観測所 ダム諸量情報 — 7 ダム (Shift_JIS HTML, 10分更新).
  // 長安口/福井/川口/正木/宮川内/棚野/池田(水). 3 cols: 貯水位/流入量/放流量.
  // Per-dam timestamps "MM/DD HH:MM" JST. Cron at :08 every hour.
  defineSource({
    id: 'tokushima-bousai',
    priority: 308,
    description: '徳島県河川砂防水位観測所 ダム諸量情報 — 7 ダム (Shift_JIS HTML, 10分更新)',
    ingestCron: '8 * * * *',
    details: {
      label: '徳島県 ダム諸量情報',
      upstream:
        '徳島県河川砂防水位観測所 ダム諸量情報 (www.kasen.pref.tokushima.lg.jp/sp/status/dam_status.html)',
      license: null,
      cadence: '10 分更新 (ダムごとの観測時刻; 取得は毎時 :08)',
      what: '徳島県の 7 ダム (長安口/福井/川口/正木/宮川内/棚野/池田(水)) の貯水位・流入量・放流量。貯水量・貯水率は掲載なし。',
    },
  }),
  // Tokyo waterworks reservoir status — open data, real values for the 14
  // single-dam rows supplying Tokyo's drinking water (Tonegawa 9 + Arakawa 4 +
  // Ogouchi). The page updates on business days; check at 03:00 UTC = 12:00 JST
  // and again at 09:00 UTC = 18:00 JST so a same-day refresh after the morning
  // publish is captured. Idempotent — runs UPSERT on (dam_id, observed_at,
  // source_id) where observed_at is the page's own date and 「N時現在」 hour.
  defineSource({
    id: 'tokyo-waterworks',
    priority: 300,
    description: '東京都水道局 / 水源情報 (real, daily, official open data)',
    ingestCron: '0 3,9 * * *',
    // Business-day page stamped with its own date (0時, 小河内 7時). A holiday
    // weekend ages it ~4.5 days; 年末年始 (closed 12/29–1/3) up to 10.5 when
    // 12/26 is the last business day and 1/5 the first. The derived 3 × p90
    // gap (~93 h) misses both: 20 stamps hold too few weekend gaps.
    freshnessOverrideHours: 11 * 24,
    details: {
      upstream: '東京都水道局 水源情報 (waterworks.metro.tokyo.lg.jp/suigen/suigen.html)',
      license: '東京都オープンデータ (出典明示で再配布可)',
      cadence: '平日の日次 (0 時 / 多摩川は 7 時現在の値; 毎日 12:00 / 18:00 JST に取得)',
      what: '東京都の水源 14 ダム (利根川・荒川・多摩川 水系) の貯水量 (万m³) と貯水率 (%)。村山・山口貯水池は 3 貯水池の合計のため取り込まない。',
      label: '東京都水道局',
    },
  }),
  // 鳥取県防災Web — 6 ダム (百谷/佐治川/東郷/賀祥/朝鍋/菅沢). Same Remix SPA
  // framework as 広島県防災Web; pointer + list JSON; storage in 千m³. 菅沢ダム
  // is sole coverage (not in tottori-dam). Cron at :33.
  defineSource({
    id: 'tottori-bousai',
    priority: 312,
    description: '鳥取県防災Web — hourly, 6ダム (百谷/佐治川/東郷/賀祥/朝鍋/菅沢; JSON feed)',
    trustedRateBasis: true,
    ingestCron: '33 * * * *',
    details: {
      upstream: '鳥取県防災Web (bousai.pref.tottori.lg.jp/dam) — /data/dam/list/{ts}.json',
      license: '公開情報 — 出典明示で再配布可',
      cadence: '時次 (元データは 10 分粒度; 取得は毎時 :33)',
      what: '鳥取県管理 6 ダム (百谷/佐治川/東郷/賀祥/朝鍋/菅沢) の貯水位・有効貯水量(千m³)・全流入量・全放流量・貯水率。菅沢ダムは本ソース唯一の観測源。',
      label: '鳥取県防災Web',
    },
  }),
  // 鳥取県ダム諸量情報システム — 5 prefectural dams (賀祥/朝鍋/佐治川/
  // 東郷/百谷). Page refreshes server-side every 10 min. Cron at :09 every
  // hour catches the freshest values.
  defineSource({
    id: 'tottori-dam',
    priority: 307,
    description: '鳥取県ダム諸量情報システム — hourly, 5 dams (賀祥/朝鍋/佐治川/東郷/百谷)',
    ingestCron: '9 * * * *',
    // Hourly real-time sources — flag if older than 3 h.
    freshnessOverrideHours: 3,
    details: {
      upstream: '鳥取県ダム諸量情報システム (tottoridam.jp)',
      license: '鳥取県オープンデータ — 出典明示で再配布可 (推定)',
      cadence: '時次 (1 時間粒度; ページは 10 分毎にリフレッシュ; 取得は毎時 :09)',
      what: '鳥取県 5 ダム (賀祥/朝鍋/佐治川/東郷/百谷) の貯水位・有効貯水量・貯水率・流入量・放流量・時間雨量。',
      label: '鳥取県ダム情報',
    },
  }),
  // 富山県 河川現況表 ダム貯水位表 — 16 ダム (kawa.pref.toyama.jp CSV, 10分更新).
  // 室牧/上市川/和田川/利賀川/白岩川/子撫川/角川/熊野川/上市川第二/朝日小川/
  // 布施川/城端/境川/大谷/久婦須川/舟川. Columns: 貯水位/全流入量/全放流量/
  // 貯水率 (利水容量). No storage volume. Cron at :16 every hour.
  defineSource({
    id: 'toyama-bousai',
    priority: 308,
    description:
      '富山県 河川現況表 ダム貯水位表 — 16 ダム (kawa.pref.toyama.jp CSV, 10分更新, 貯水率 利水容量)',
    ingestCron: '16 * * * *',
    details: {
      label: '富山県 河川現況表',
      upstream:
        '富山県 河川現況表 ダム貯水位表 (kawa.pref.toyama.jp/camera/02condlist.html?id=0&sel=3 — data/damname_data.csv・dam_data.csv)',
      license: null,
      cadence: '10分更新 (毎時 :16 に取得)',
      what: '富山県管理 16 ダム (室牧/上市川/和田川/利賀川/白岩川/子撫川/角川/熊野川/上市川第二/朝日小川/布施川/城端/境川/大谷/久婦須川/舟川) の貯水位・全流入量・全放流量・貯水率 (利水容量)。貯水量は非公開、熊野川/朝日小川は貯水率も非表示。利賀川・角川・舟川の流量はページのスクリプトと同じ換算で m³/s に直す。',
    },
  }),
  // 和歌山県河川／雨量防災情報 ダム諸量 — 19 ダム (広川/二川/椿山/七川/切目川/殿山/
  // 小匠 [pref] + 猿谷/九尾/川迫/大滝/大迫/津風呂 [国直轄・吉野川系] + 坂本/池原/七色/
  // 二津野/小森/風屋 [国直轄・北山川系]). Single EUC-JP CSV (dinfo.csv); no header.
  // Priority 308. Cron at :41.
  defineSource({
    id: 'wakayama-kasen',
    priority: 308,
    description: '和歌山県河川防災情報 ダム諸量 — 19 ダム hourly CSV',
    ingestCron: '41 * * * *',
    details: {
      label: '和歌山県 河川防災情報',
      upstream:
        '和歌山県河川／雨量防災情報 ダム諸量 (kasensabo01.pref.wakayama.lg.jp/hyoujidata/dinfo.csv)',
      license: null,
      cadence: '時次 (取得は毎時 :41)',
      what: '和歌山県 19 ダム — 県管理 7 (広川/二川/椿山/七川/切目川/殿山/小匠) + 国直轄 12 (吉野川系: 猿谷/九尾/川迫/大滝/大迫/津風呂、北山川系: 坂本/池原/七色/二津野/小森/風屋) — の貯水位・貯水量(千m³)・流入量・放流量。CSV に貯水率の列はない。',
    },
  }),
  // Cover-image and elevation refresh — monthly, staggered to avoid hitting the
  // upstream APIs all at once.
  defineSource({
    id: 'wikipedia',
    priority: 0,
    description: 'ja.wikipedia.org — ダム写真のフォールバック (記事サムネイル)',
    providesObservations: false,
    jobs: [{ cron: '0 5 2 * *', task: 'images:refresh:wikipedia' }],
    details: {
      upstream: 'ja.wikipedia.org REST API (pageimages prop)',
      license: 'CC-BY-SA 4.0 (各ページの著作者に従う)',
      cadence: '月 1 回 (images:refresh:wikipedia cron / 毎月 2 日 05:00 UTC)',
      what: 'Damnet に写真がない場合のフォールバック。記事サムネイル URL のみ。',
      label: 'Wikipedia',
    },
  }),
  // 山形県河川・砂防情報 — ~17 ダム (県管理13 + 国管理4: 長井/寒河江/白川/月山).
  // 防災Web JSON feed (dk=4, Shift_JIS), 10分更新. Level + storage (千m³) + rate +
  // inflow + outflow. Priority 308, matching other 防災Web prefectural sources.
  // Cron at :51 (spaced from shimokubo :49 and ktr-kinu :17).
  defineSource({
    id: 'yamagata-bousai',
    priority: 308,
    description: '山形県河川・砂防情報 — 防災Web JSON dk=4, hourly (~17 ダム)',
    trustedRateBasis: true,
    ingestCron: '51 * * * *',
    details: {
      label: '山形県 河川・砂防情報',
      upstream:
        '山形県河川・砂防情報 防災Web (www.kasen.pref.yamagata.jp/map/servlet/bousaiweb.servletBousaiMap?dk=4)',
      license: null,
      cadence: '時次 (元データは 10 分更新; 取得は毎時 :51)',
      what: '山形県 ~17 ダム (県管理 13: 蔵王/前川/白水川/留山川/高坂/神室/最上小国川/木地山/綱木川/月光川/荒沢/温海川/田沢川 + 国管理 4: 長井/寒河江/白川/月山) の貯水位・貯水量 (千m³→m³)・貯水率・流入量・放流量。',
    },
  }),
  // 山口県土木防災情報システム ダム観測局 — 23 ダム (小瀬川/生見川/御庄川/中山川/平瀬/
  // 今富/厚東川/真締川/末武川/木屋川/向道/菅野/川上/屋代/佐波川/荒谷/一の坂/湯免/
  // 大坊/見島/阿武川/黒杭川/黒杭川上流). UTF-8 ASPX HTML; one fetch per station;
  // writes all 24 on-the-hour rows (class="hour_XX") of the page's 24-hour table;
  // waterLevel + storageRate + inflow + outflow (no volume).
  // Priority 308. Cron at :46.
  defineSource({
    id: 'yamaguchi-bousai',
    priority: 308,
    description: '山口県土木防災情報システム ダム観測局 — 23 ダム hourly HTML',
    ingestCron: '46 * * * *',
    details: {
      label: '山口県 土木防災情報',
      upstream:
        '山口県土木防災情報システム ダム観測局 (y-bousai.pref.yamaguchi.lg.jp/sp/dam/spdmObserve.aspx?stncd=NNN)',
      license: null,
      cadence: '10 分粒度 (直近 24 時間の表; 取得は毎時 :46 に毎正時 24 行を書き込み)',
      what: '山口県の 23 ダム (小瀬川/生見川/御庄川/中山川/平瀬/今富/厚東川/真締川/末武川/木屋川/向道/菅野/川上/屋代/佐波川/荒谷/一の坂/湯免/大坊/見島/阿武川/黒杭川/黒杭川上流) の貯水位・貯水率・流入量・全放流量。貯水量は掲載なし。',
    },
  }),
  // 山梨県雨量・水位情報 ダム状況表 — 6 県管理ダム (大門/塩川/広瀬/琴川/荒川/深城).
  // Shift_JIS HTML; one page lists every dam. Handles "24時00分" midnight.
  // level + storage volume + inflow + outflow + hourly rain (no rate). Cron at :36.
  defineSource({
    id: 'yamanashi-dam',
    priority: 280,
    description: '山梨県雨量・水位情報 ダム状況表 — 6 県管理ダム (Shift_JIS HTML)',
    ingestCron: '36 * * * *',
    details: {
      label: '山梨県 雨量・水位情報',
      upstream:
        '山梨県雨量・水位情報 ダム状況表 (www3.pref.yamanashi.jp/yamanashiweb/sub/dam/dam005.asp?pAu=2)',
      license: null,
      cadence: '時次 (最新の 1 時間値; 取得は毎時 :36)',
      what: '山梨県管理 6 ダム (大門/塩川/広瀬/琴川/荒川/深城) の貯水位 (EL.m)・貯水量 (千m³)・全流入量・全放流量・時間雨量。貯水率は非公開。',
    },
  }),
  // 米沢平野土地改良区「用水状況」— 水窪ダム (東北農政局) の貯水量 (千m3)。
  // 毎週月曜 (祝日は翌日) 更新、キャプションに「Y.M.D現在」。当年度アーカイブ
  // ページ (週次の全件) も毎回読み、調査日 00:00 JST へ冪等 UPSERT。
  // 月曜 13 時台の更新後に拾うため 07:13 UTC (16:13 JST) の日次。
  defineSource({
    id: 'yonezawa-heiya',
    priority: 278,
    description: '米沢平野土地改良区 用水状況 — 水窪ダム貯水量 (週次 HTML)',
    ingestCron: '13 7 * * *',
    details: {
      upstream:
        '米沢平野土地改良区「用水状況」 (yonezawa-heiya.or.jp/pages/150/ と当年度アーカイブ)',
      license:
        '利用条件の記載なし (サイト表記は「Copyright© 米沢平野土地改良区 All Rights Reserved.」のみ)。本サイトは観測値 (事実データ) のみを出典明示のうえ掲載。',
      cadence:
        '週次 (毎週月曜・祝日は翌日の「Y.M.D現在」値, 年末年始は 2 週間空く; 時刻非公表のため 00:00 JST で記録; 取得は毎日 16:13 JST)',
      what: '水窪ダム (東北農政局の農業用ダム, 米沢平野土地改良区管理) の貯水量(千m³)。水位・貯水率・流量は非公開。当年度の週次値を毎回取り込み。',
      label: '米沢平野土地改良区',
    },
  }),
];
