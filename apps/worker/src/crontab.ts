// apps/worker/src/crontab.ts
// graphile-worker crontab format: https://github.com/graphile/worker
// All times below are UTC (graphile-worker doesn't take a timezone). Display
// time in the UI is always JST (Asia/Tokyo) — see lib/format.ts.
//
// Note: graphile-worker's crontab parser only allows [_a-zA-Z][_a-zA-Z0-9:_-]*
// for task identifiers, so we use colons instead of dots.
export const CRONTAB = `
# 秋田県河川砂防情報システム ダム一覧表 — 18 県管理ダム (防災Web HTML table, Shift_JIS,
# no session). 12 columns: level / inflow / outflow (no storage volume).
# Cron at :01.
1 * * * * ingest:akita-kasen

# Master refresh
0 3 1 * * master:refresh:ndi
0 3 5 * * master:refresh:damnet
0 4 * * * master:match

# 川の防災情報 v2 — 800+ dams via tmlist/dam/{date}/{time}/{obs_fcd}.json.
# Requires match:kasenbosai to have seeded external_ids.kasenbosai first.
# Snap to 10-min cadence at :03 (give the source 3 min headroom past the
# 10-min boundary, then concurrent fetches across 800+ dams take ~3 min
# at concurrency=8).
3 * * * * ingest:kasenbosai-v2

# Seed / refresh external_ids.kasenbosai by sweeping the kawabou dam catalogue
# GeoJSON (49 prefecture files, ~900 dams) and matching by name + distance.
# Weekly on Monday 03:30 UTC (12:30 JST). After first run this cron keeps new
# dams matched as the kawabou catalogue grows.
30 3 * * 1 match:kasenbosai

# Tokyo waterworks daily reservoir status — open data, real values for the
# 13 dams supplying Tokyo's drinking water (Tonegawa 9 + Arakawa 4 +
# Tamagawa 2). Page updates daily; check at 03:00 UTC = 12:00 JST and again
# at 09:00 UTC = 18:00 JST so a same-day refresh after the morning publish
# is captured. Idempotent — repeated runs UPSERT on (dam_id, observed_at,
# source_id) where observed_at is snapped to today 00:00 JST.
0 3,9 * * * ingest:tokyo-waterworks

# JWA 旬報 — 21 dams across 7 major water systems (Tonegawa, Arakawa, Kisogawa,
# Toyokawa, Yodogawa, Yoshinogawa, Chikugogawa). Published every 10 days
# (1st/11th/21st of each month JST). Daily polling at 04:00 UTC = 13:00 JST
# is cheap (idempotent UPSERT on the report-date timestamp) and catches a
# new publication within ~24 h regardless of which exact day it lands on.
0 4 * * * ingest:jwa-junpo

# あいとよネット (aitoyo) — 7 dams across 木曽川 / 豊川 / 矢作川 系. Page is
# updated daily at 24:00 JST (木曽川/豊川) or 09:00 JST (矢作川); fetch at
# 02:00 UTC = 11:00 JST so we get fresh data for both branches.
0 2 * * * ingest:aitoyo

# JWA Chikugo (筑後川 7 dams: 松原/下筌/大山/合所/江川/寺内/小石原川). Page
# shows today 0時 JST values, refreshed during business hours. Fetch at
# 01:00 UTC = 10:00 JST.
0 1 * * * ingest:jwa-chikugo

# かながわの水がめ JSON API — hourly cadence for 5 prefectural dams
# (相模/城山/三保/宮ヶ瀬/道志). Page rolls a 30-hour window; cron at
# every hour :05 captures the freshest reading shortly after the
# source's update.
5 * * * * ingest:kanagawa-dam

# 滋賀県土木防災 — 6 prefectural dams, hourly. Page exposes a 23-hour
# window per fetch; cron at every hour :07 catches today's freshest
# value + 22 hours of context for self-healing.
7 * * * * ingest:shiga-bousai

# 鳥取県ダム諸量情報システム — 5 prefectural dams (賀祥/朝鍋/佐治川/
# 東郷/百谷). Page refreshes server-side every 10 min. Cron at :09 every
# hour catches the freshest values.
9 * * * * ingest:tottori-dam

# 青森県砂防ダム情報 — 7 dams. Page is real-time (JST minute-level
# timestamp). Cron at :11 every hour.
11 * * * * ingest:aomori-dam

# 愛知県 川の防災情報 ダム表 — 2 県管理ダム (雨山/木瀬). UTF-8 HTML; 10分更新.
# Stores 24h of 10-min data per fetch. Cron at :12 every hour.
12 * * * * ingest:aichi-kasen

# 国土交通省 近畿地方整備局 — 12 国管理ダム 貯水率 (JSON feed, 日次, 土日祝除く).
# managawa/kuzuryu (Fukui), amagase/hiyoshi (Kyoto), muro/syourenji/takayama/
# nunome/hinati/otaki/sarutani (Nara/Mie), hitokura (Hyogo). storageRate only.
# Cron at 03:00 UTC = 12:00 JST on weekdays. Weekend runs return same data
# (or cached page); UPSERT on (dam_id, observed_at, source_id) is idempotent.
0 3 * * * ingest:kkr-mlit-dam

# 水資源機構 千葉用水総合管理所 房総導水路管理所 — 長柄ダム / 東金ダム 日次 (HTML, 閉庁日除く).
# Manually updated page: water level (EL.m) + storage rate (%) at midnight JST.
# Not on 千葉県水道局 page — JWA-managed, not prefecture-managed.
# Priority 302. Cron daily at 03:00 UTC = 12:00 JST.
0 3 * * * ingest:jwa-chiba-bouso

# 沖縄県企業局 — 倉敷ダム (県管理) / 山城ダム (企業局管理) 日次 (CSV, 午前0時時点).
# Source: www.eb.pref.okinawa.jp/js/chart/dam-youryou.csv
# 5-row CSV with storage volume (千m³) and rate (%) per group.
# Priority 302. Cron daily at 03:00 UTC = 12:00 JST.
0 3 * * * ingest:okinawa-eb

# 国土交通省 北海道開発局 — 18 直轄 dams (info-dam.hdb.hkd.mlit.go.jp).
# Page table has 10-minute cadence; we fetch hourly at :13 to spread load
# from other prefectural sources.
13 * * * * ingest:hkd-mlit-dam

# 福井県 河川・砂防総合情報システム ダム諸量現況表 — 13 ダム (防災Web Shift_JIS, hourly).
# 永平寺/二ツ屋/浄土寺川/龍ヶ鼻/笹生川/桝谷/広野/河内川/大津呂/開谷/滝波 + 真名川/九頭竜(KKR).
# Priority 308 upgrades kkr-mlit-dam (daily, priority 302) for 真名川/九頭竜.
# Cron at :14 every hour.
14 * * * * ingest:fukui-bousai

# 奈良県河川情報システム モバイル ダム現況 — 5 ダム (Shift_JIS HTML, ~10分更新).
# 岩井川/天理/白川/初瀬/大門. 貯水位/流入量/放流量のみ (no storage).
# Each dam is a separate table; latest row has "MM/DD HH:MM" JST timestamp.
# Cron at :18 every hour.
18 * * * * ingest:nara-kasen

# 富山県 県内ダム情報実況表 — 16 ダム (Salesforce public page, hourly).
# 室牧/上市川/和田川/利賀川/白岩川/子撫川/角川/熊野川/上市川第二/朝日小川/
# 布施川/城端/境川/大谷/久婦須川/舟川. Columns: 全流入量/全放流量/貯水位のみ.
# No storage volume. HTML numeric entity-encoded. Cron at :16 every hour.
16 * * * * ingest:toyama-bousai

# 国土交通省 中国地方整備局 — 11 国管理 dams across 5 prefectures
# (岡山/広島/山口/鳥取/島根). Single POST JSON gives all dams' current
# values. Cron at :15 every hour.
15 * * * * ingest:cgr-mlit-dam

# 国土交通省 関東地方整備局 鬼怒川ダム統管 — 4 dams (栃木県:
# 五十里/川俣/川治/湯西川). realDM.html embeds the 4 dams' values
# inline as JS arrays (10-min cadence at source). Cron at :17.
17 * * * * ingest:ktr-kinu-dam

# 国土交通省 北陸地方整備局 — 7 dams across 6 prefectures (福島/山形/
# 新潟/長野/富山/石川). CSV-like tmDam.txt feed has current values for
# all dams in one fetch. Cron at :19.
19 * * * * ingest:hrr-mlit-dam

# 国土交通省 関東地方整備局 利根川ダム統合管理事務所 — 9 国管理ダム
# (矢木沢/奈良俣/藤原/相俣/薗原/八ッ場/下久保/草木/渡良瀬貯水池).
# Single JSON gives all dams' current hourly values. Cron at :20.
20 * * * * ingest:ktr-tone-dam

# 国土交通省 九州地方整備局 鶴田ダム管理所 — 鶴田ダム (川内川水系, 鹿児島/46).
# EUC-JP HTML table, 10分更新; type=2 endpoint, 7 cols. Cron at :22.
22 * * * * ingest:qsr-turuta-dam

# 国土交通省 九州地方整備局 竜門ダム管理所 — 竜門ダム (佐田川水系, 福岡/40).
# PHP key-value endpoint (data.php?key=); 6 keys fetched in parallel: time /
# ryunyu / houryu / chosuiryo / chosuii / chosuiritsu. Full data: storage +
# rate + level + inflow + outflow. Cron at :24.
24 * * * * ingest:qsr-ryumon-dam

# 国土交通省 九州地方整備局 筑後川ダム統合管理事務所 — 2 国管理ダム (筑後川水系, 大分/44).
# 松原ダム / 下筌ダム. Single HTML page with 2 tables (one per dam); one data
# row each. level + inflow + 全放流量 + hourly rain (no storage). Cron at :26.
26 * * * * ingest:qsr-toukan-dam

# 国土交通省 四国地方整備局 肱川ダム統合管理事務所 — 野村・鹿野川ダム (肱川水系, 愛媛/38).
# www1.river.go.jp CGI (EUC-JP HTML + IFRAME), 10分更新; 2 dams, 4 HTTP requests.
# Cron at :23.
23 * * * * ingest:skr-hiji-dam

# 千葉県 県内ダムの貯水状況 — 23 dams (水道用+工業用水). Daily 9 JST
# publish. Fetch at 02:30 UTC = 11:30 JST, giving upstream 2.5h headroom.
30 2 * * * ingest:chiba-suisei

# おかやま防災ポータル — ~15 県管理ダム (JSON feed, 30分更新). A pointer
# fetch yields the freshest snapshot file with every dam's values. Cron at
# :21 every hour, spaced from the other prefectural sources.
21 * * * * ingest:okayama-bousai

# 新潟県河川防災情報システム — ~20 県管理ダム (防災Web servlet dk=4 table).
# Session cookie + single Shift_JIS table fetch gives every dam's level /
# 貯水率 / inflow / outflow. Cron at :23 every hour.
23 * * * * ingest:niigata-bousai

# 兵庫県 ダム諸量 — 22観測所 (BODIK オープンデータ CSV, CC-BY 4.0, 10分更新).
# Single CSV fetch gives level / 貯水量(千m³) / inflow / outflow. Cron at :25.
25 * * * * ingest:hyogo-bodik

# 栃木県河川水位・雨量情報システム — 7観測所 (BODIK ダム諸量 NGSI-v2 CSV,
# CC-BY 4.0, 10分更新). dateObserved is ISO UTC, waterStorage in 千m³.
# Cron at :27.
27 * * * * ingest:tochigi-bodik

# 石川県河川総合情報システム ダム諸量 — 11 県管理ダム hourly JSON.
# 八ヶ川/新内川/内川/赤瀬/我谷/九谷/小屋/北河内/辰巳/犀川/大日川.
# item_10=貯水位 / item_20=貯水量(千m³) / item_50=流入量 / item_70=放流量.
# Cron at :28 every hour.
28 * * * * ingest:ishikawa-kasen

# 広島県防災Web — 18 ダム (JSON feed, 10分更新). Pointer + list feed; storage
# in 千m³. Prefectural (managerCd 23/24/26) + 5 MLIT dams already in
# cgr-mlit-dam (priority 304 wins for those). Cron at :29.
29 * * * * ingest:hiroshima-bousai

# 大阪府河川防災情報 — 3 県管理ダム (安威川/箕面川/狭山池). Single JSON fetch;
# displayDt is YYYYMMDDHHMM JST. Cron at :31.
31 * * * * ingest:osaka-bousai

# 鳥取県防災Web — 6 ダム (百谷/佐治川/東郷/賀祥/朝鍋/菅沢). Same Remix SPA
# framework as 広島県防災Web; pointer + list JSON; storage in 千m³. 菅沢ダム
# is sole coverage (not in tottori-dam). Cron at :33.
33 * * * * ingest:tottori-bousai

# 福岡市関連9ダム — BODIK open data (CC-BY), hourly Shift-JIS CSV.
# Storage in 千m³ (南畑/五ケ山/脊振/曲渕/江川/久原/長谷/猪野/瑞梅寺).
# Cron at :35.
35 * * * * ingest:fukuoka-bodik

# 岐阜県 川の防災情報 ダム諸量 — 14 ダム (UTF-8 HTML, hourly).
# 阿多岐/大ヶ洞/岩村/中野方/丹生川/矢作/小里川/横山/徳山/丸山/阿木川/岩屋/牧尾/味噌川.
# Priority 308 upgrades overlapping jwa-chubu/aitoyo dams from daily to hourly.
# Cron at :10 every hour.
10 * * * * ingest:gifu-kasen

# 水資源機構 関東支社 利根川/荒川系 — 13 facilities (9 Tone + 4 Ara).
# Daily 0時 JST static HTML; 万m³ units. New dams: 藤原/相俣/薗原/八ッ場/二瀬.
# Overlap dams (矢木沢/奈良俣/下久保/草木/浦山/滝沢) get daily cadence. Cron at :39.
39 * * * * ingest:jwa-toneara

# 水資源機構 中部支社 木曽川水系 — 6 dams (牧尾/阿木川/味噌川/岩屋/中里/徳山).
# Daily static HTML; 千m³ storage + inflow/outflow. New: 中里ダム. Cron at :41.
41 * * * * ingest:jwa-chubu

# 水資源機構 中部支社 豊川水系 — 2 dams (宇連/大島). Real-time page updated
# every ~10 min; water level (EL.m) + 有効貯水量(m³) + inflow/outflow. Upgrades
# 宇連/大島 from daily (aitoyo) to hourly cadence. Cron at :43.
43 * * * * ingest:jwa-toyokawa

# 水資源機構 吉野川上流総合管理所 — 5 dams (池田/早明浦/新宮/富郷/柳瀬).
# Hourly real-time page (UTF-8); 貯水位(EL.m) + 流入量 + 全放流量 for all 5.
# 早明浦ダムのみ利水貯水率[速報値]あり (四国の水不足指標). Cron at :45.
45 * * * * ingest:jwa-yoshino

# 水資源機構 中部支社 木曽川水系 実時計 — 6 dams (牧尾/味噌川/阿木川/岩屋/徳山/中里).
# Real-time page (~10 min cadence); 貯水位(EL.m) + 有効貯水量(10³m³) + inflow/outflow.
# Upgrades jwa-chubu (daily, priority 296) to hourly. Priority 297. Cron at :47.
47 * * * * ingest:jwa-kiso-rt

# 群馬県水位雨量情報システム ダム現況表 — 7 県管理ダム hourly (Shift_JIS HTML,
# 坂本/霧積/塩沢/四万川/道平川/大仁田/桐生川). One fetch per station index (1–7);
# timestamp "MM月DD日HH時mm分現在" JST (no year); volume in 千m³; arrow
# indicators (→↑↓) stripped. Priority 308. Cron at :48.
48 * * * * ingest:gunma-kasen

# 水資源機構 利根川上流総合管理所 下久保ダム — 1 dam (群馬/埼玉境). JSON feed
# (UTF-8-BOM), 10分更新. Upgrades jwa-toneara (daily, priority 296) → hourly for
# 下久保ダム. Priority 297. Cron at :49.
49 * * * * ingest:shimokubo

# 山形県河川・砂防情報 — ~17 ダム (県管理13 + 国管理4: 長井/寒河江/白川/月山).
# 防災Web JSON feed (dk=4, Shift_JIS), 10分更新. Level + storage (千m³) + rate +
# inflow + outflow. Priority 308, matching other 防災Web prefectural sources.
# Cron at :51 (spaced from shimokubo :49 and ktr-kinu :17).
51 * * * * ingest:yamagata-bousai

# 茨城県河川防災情報 — 7 県管理ダム (小山/飯田/藤井川/竜神/十王/花貫/花園).
# 防災Web HTML table (Shift_JIS), no session required. 9 columns including
# storage volume (千m³) but no 貯水率. Cron at :53.
53 * * * * ingest:ibaraki-bousai

# 徳島県河川砂防水位観測所 ダム諸量情報 — 7 ダム (Shift_JIS HTML, 10分更新).
# 長安口/福井/川口/正木/宮川内/棚野/池田(水). 3 cols: 貯水位/流入量/放流量.
# Per-dam timestamps "MM/DD HH:MM" JST. Cron at :08 every hour.
8 * * * * ingest:tokushima-bousai

# 長崎県河川砂防情報 ダム情報 — 35 ダム (lv / 貯水量(千m³) / 貯水率 / in / out).
# JSON API (dt_range.json → snapshot URL). 30分更新. Cron at :02 and :32 to
# catch both the :00 and :30 snapshots each hour.
2,32 * * * * ingest:nagasaki-kasen

# 宮城県土木総合情報システム ダム現況表 — 21 ダム (18 県管理 + 3 国管理).
# Gamen42Servlet: 1 request = all dams. 10 columns: level / 貯水量(10³m³) /
# inflow / outflow / 貯水率(利水容量). Cron at :06 every hour.
6 * * * * ingest:miyagi-kasen

# 熊本県防災情報システム 地方別ダム情報 — 6 ダム (市房/氷川/石打/上津浦/亀川/路木).
# Shift_JIS JS page; DspDat[] array; 有効貯水量(千m³) / 貯水位 / 全流入量 / 全放流量 /
# 貯水率(有効容量). 60分更新. Cron at :04 every hour.
4 * * * * ingest:kumamoto-bousai

# 宮崎県河川・砂防水位観測所 — 13 県管理ダム (防災Web servlet, Shift_JIS,
# no session). 8 columns: level / inflow / outflow (no storage volume).
# Cron at :55.
55 * * * * ingest:miyazaki-bousai

# 山梨県雨量・水位情報 時間ダム諸量表 — 6 県管理ダム (大門/塩川/広瀬/琴川/荒川/深城).
# Shift_JIS HTML; 6 parallel requests (one per dam). Handles "24:00" midnight.
# level + inflow + outflow + hourly rain (no storage volume). Cron at :36.
36 * * * * ingest:yamanashi-dam

# 長野県 河川砂防情報ステーション ダム諸量 — 17 県管理ダム (松川/片桐/箕輪/横川/
# 奈良井/裾花/奥裾花/古谷/内村/豊丘/余地/北山/浅川/水上/小仁熊/湯川/金原).
# Same JSON pattern as 石川/福島 (sabo-nagano.jp); uses "value"/"level" keys
# (not "val"/"lvl"); has item_20 storage volume (×1000 m³). Cron at :33.
33 * * * * ingest:nagano-kasen

# 福島県河川流域総合情報システム — 11 県管理ダム (こまち/千五沢/堀川/真野/木戸/
# 小玉/高柴/四時/日中/東山/田島). JST-dated JSON URL; item_10=貯水位 /
# item_50=流入量 / item_70=放流量 / item_1_70=時間雨量 (no storage volume).
# Same framework as 石川県河川総合情報システム. Cron at :34.
34 * * * * ingest:fukushima-kasen

# 福島県 農林水産部 県内の主要農業関係ダムの貯水状況 — 農業用ダム 29 基
# (岳/藤倉/山ノ入/三ツ森/深田調整池/金沢調整池 ほか)。土木部の
# ingest:fukushima-kasen とは対象ダムが重ならない。HTML 1 テーブル、
# 貯水率（かんがい用水）のみ。調査日ベースで隔週更新なので、jwa-junpo と同じく
# 日次ポーリング (報告日タイムスタンプへの冪等 UPSERT) で拾う。
15 4 * * * ingest:fukushima-nourin

# 大分県 農林水産部 農地・農村整備課「農業用ダム貯水率一覧」— 農業用ダム 21 基
# (石山/鍋倉/久木野尾/乙見/末広/中ノ川/石場/大舞 ほか)。土木部の
# ingest:oita-bousai とは対象ダムがほぼ重ならない。PDF 1 テーブル、
# 有効貯水量・現貯水量・貯水率。かんがい期 (4-9月) は月2回、それ以外は月1回の
# 調査日ベースなので、fukushima-nourin と同じく日次ポーリングで拾う
# (調査日タイムスタンプへの冪等 UPSERT)。#27
35 4 * * * ingest:oita-nourin

# 岩手県河川情報システム — 10 県管理ダム (Gamen32Servlet, Shift_JIS, one
# request per station). Columns: level / 貯水量(千m³) / inflow / outflow.
# Cron at :57.
57 * * * * ingest:iwate-kasen

# 大分県河川情報 ダム諸量現況表 — 10 県管理ダム (防災Web HTML table, Shift_JIS,
# no session). 10 columns: level / inflow / 貯水量(千m³) / 貯水率 / outflow.
# Cron at :59.
59 * * * * ingest:oita-bousai

# かがわ防災Webポータル ダム諸量 — 18 ダム (椛川/門入/千足/内海/吉田/内場/野口/
# 長柄/前山/殿川/粟井/五名/田万/大川/大内/五郷/府中/粟地). Single JSON fetch;
# clean structured data with storageRate + storageVolumeM3 + waterLevel +
# inflow + outflow. Updated every 10 min. Cron at :39.
39 * * * * ingest:kagawa-bousai

# 静岡県 河川・砂防情報システム ダム諸量現況表 — 県管理ダム (防災Web HTML, Shift_JIS).
# URL: kasen.pref.shizuoka.lg.jp (geo-blocked outside Japan; works from production).
# Header-detection parser handles variable column layout. Cron at :55.
55 * * * * ingest:shizuoka-bousai

# 愛媛県 河川砂防総合情報システム ダム諸量現況表 — 県管理ダム (防災Web HTML, Shift_JIS).
# URL: kasen.pref.ehime.jp (geo-blocked outside Japan; works from production).
# National dams (野村/鹿野川 via skr-hiji, 富郷/柳瀬 via jwa-yoshino) already covered.
# Cron at :57.
57 * * * * ingest:ehime-bousai

# 兵庫県 丹波農林振興事務所 ダムテレメータ — 6 dams (鍔市/八幡谷/藤岡/佐仲/黒石/大杉).
# Tanba area dams; Shift_JIS HTML single-latest-value display. PSNO=2,4 currently
# offline (0000/00/00 timestamps). Storage volume in direct m³ (not 千m³).
# URL: tndam.pref.hyogo.lg.jp/dam/DamData.jsp?PSNO={1-6}. Cron at :53.
53 * * * * ingest:tndam-hyogo

# 鹿児島県防災ポータル ダム情報 — 県管理ダム (JSON API, globally accessible).
# NOTE: Returns empty items during normal conditions; populated only during
# active flood/disaster events. Adapter exits early when no data present.
56 * * * * ingest:kagoshima-bousai

# 佐賀県河川砂防情報システム ダム現況表 — 19 県管理ダム (岸川/庭木/繁昌/天ヶ瀬/
# 平木場/伊岐佐/都川内/井手口川/竜門/有田/古木場/本部/矢筈/狩立日ノ峯/中木庭/
# 岩屋川内/横竹/深浦/河内). Transposed Shift_JIS HTML table; 3 pages (7+7+5
# dams) fetched in parallel. Dam names are column headers (not row labels).
# Cron at :40.
40 * * * * ingest:saga-bousai

# 和歌山県河川／雨量防災情報 ダム諸量 — 19 ダム (広川/二川/椿山/七川/切目川/殿山/
# 小匠 [pref] + 猿谷/九尾/川迫/大滝/大迫/津風呂 [国直轄・吉野川系] + 坂本/池原/七色/
# 二津野/小森/風屋 [国直轄・北山川系]). Single EUC-JP CSV (dinfo.csv); no header.
# Priority 308. Cron at :41.
41 * * * * ingest:wakayama-kasen

# 京都府 河川防災情報 ダム諸量現況表 — 6 ダム (大野/畑川 [大野ダム管理] +
# 天ヶ瀬 [淀川ダム統管] + 日吉/高山/布目 [水資源機構]).
# Shift_JIS HTML; standard row-per-dam table; volume in ×10³m³.
# Priority 308. Cron at :42.
42 * * * * ingest:kyoto-bousai

# 埼玉県 川の防災情報 ダム諸量 — 9 ダム (合角/有間/権現堂調節池 [県管理] +
# 渡良瀬遊水地/二瀬/荒川第一調節池/浦山/滝沢/下久保 [国管理]).
# UTF-8 CSV; timestamp YYYYMMDDHHmm JST; volume in 千m³; missing as "c"/"*".
# Priority 308. Cron at :44.
44 * * * * ingest:saitama-suibo

# 山口県土木防災情報システム ダム観測局 — 23 ダム (小瀬川/生見川/御庄川/中山川/平瀬/
# 今富/厚東川/真締川/末武川/木屋川/向道/菅野/川上/屋代/佐波川/荒谷/一の坂/湯免/
# 大坊/見島/阿武川/黒杭川/黒杭川上流). UTF-8 ASPX HTML; one fetch per station;
# table rows class="hour_XX"; waterLevel + storageRate + inflow + outflow (no volume).
# Priority 308. Cron at :46.
46 * * * * ingest:yamaguchi-bousai

# 高知県水防情報システム ダム諸量現況表 — 11 ダム (和食/永瀬/鎌井谷/鏡/桐見/坂本/
# 以布利川 [pref] + 早明浦/大渡/中筋川/横瀬川 [国交省]). Pre-generated static
# Shift_JIS HTML (tableStatusDam_0_1_0_now.html); no servlet call needed.
# Provides storageRate + storageVolumeM3 + waterLevel + inflow + outflow.
# Priority 308. Cron at :38.
38 * * * * ingest:kochi-bousai

# 島根県防災Web — 14 県管理ダム (布部/山佐/三瓶/波積/八戸/浜田/第二浜田/大長見/
# 御部/益田川/笹倉/大峠/銚子/美田). Same Remix SPA framework as 広島/鳥取県防災Web;
# pointer + list JSON; storage in 千m³. 国直轄 (尾原/志津見) also appear but
# cgr-mlit-dam (priority 304) wins preferredSource for those. Cron at :37.
37 * * * * ingest:shimane-bousai

# 鹿児島県 BODIK ダム諸量 — 3 dams (大和/川辺/西之谷), 10-min, 2008+, CC-BY.
# Historical ZIP archives (monthly updates). Run on demand:
#   add_job('backfill:kagoshima-bodik', { fromYear: 2024 })  -- recent years
#   add_job('backfill:kagoshima-bodik', {})                  -- full 2008+ history

# Suimon backfill remains opt-in only. Enqueue ad-hoc jobs via add_job
# rather than running it on a fixed cron, so we don't keep hammering the
# upstream when there's nothing new to import.

# mudam tail backfill — monthly increment. mudam publishes confirmed values
# with a 1-2 year lag, so once or twice a year a new year-block of data
# becomes available. Running over all 9 districts × 1 year is ~90 min and
# imports any newly-published rows idempotently. 05 UTC on day 20 = 14:00
# JST on the 20th, well-spaced from other cron storms.
# Payload is JSON5 inside {} per graphile-worker convention.
0 5 20 * * backfill:mudam {"district":"all","years":1}

# Continuous-aggregate full-history refresh — the obs_daily policy only
# covers the trailing 60 days, so freshly backfilled history (mudam) never
# materializes on its own and 平年比 queries read obs_daily. Runs 3 h after
# the mudam tail backfill starts (that run takes ~90 min).
0 8 20 * * aggregates:refresh

# Quality recomputation
30 4 * * * quality:recompute

# Storage rate backfill — runs daily just after quality recompute,
# filling in storage_rate from volume / capacity for sources that don't provide it.
45 4 * * * storageRate:recompute

# Freshness watchdog — every hour, scan source_priorities and flag any source
# whose newest observation is older than the per-source expected window
# (see apps/worker/src/tasks/quality_freshness.ts). Posts a digest to
# DISCORD_FRESHNESS_WEBHOOK if set; else logs warnings only.
35 * * * * quality:freshness-check

# Cover-image and elevation refresh — monthly, staggered to avoid hitting the
# upstream APIs all at once.
0 5 2 * * images:refresh:wikipedia
0 5 3 * * master:refresh:elevation
`;
