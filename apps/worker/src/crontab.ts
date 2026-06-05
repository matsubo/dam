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

# Observation ingest. Hourly cadence keeps storage charts fresh without
# hammering upstream — the kasenbosai adapter only fetches dams that have an
# external_ids->>'kasenbosai' set, so empty matches are cheap. Once
# beta-stage name-matching populates those IDs, this cron starts producing
# real observations on its own.
0 * * * * ingest:kasenbosai

# 川の防災情報 v2 — 800+ dams via tmlist/dam/{date}/{time}/{obs_fcd}.json.
# Requires match:kasenbosai to have seeded external_ids.kasenbosai first.
# Snap to 10-min cadence at :03 (give the source 3 min headroom past the
# 10-min boundary, then concurrent fetches across 800+ dams take ~3 min
# at concurrency=8).
3 * * * * ingest:kasenbosai-v2

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

# 岩手県河川情報システム — 10 県管理ダム (Gamen32Servlet, Shift_JIS, one
# request per station). Columns: level / 貯水量(千m³) / inflow / outflow.
# Cron at :57.
57 * * * * ingest:iwate-kasen

# 大分県河川情報 ダム諸量現況表 — 10 県管理ダム (防災Web HTML table, Shift_JIS,
# no session). 10 columns: level / inflow / 貯水量(千m³) / 貯水率 / outflow.
# Cron at :59.
59 * * * * ingest:oita-bousai

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

# Quality recomputation
30 4 * * * quality:recompute

# Freshness watchdog — every hour, scan source_priorities and flag any source
# whose newest observation is older than the per-source expected window
# (see apps/worker/src/tasks/quality_freshness.ts). Posts a digest to
# DISCORD_FRESHNESS_WEBHOOK if set; else logs warnings only.
35 * * * * quality:freshness-check

# Cover-image and elevation refresh — monthly, staggered to avoid hitting the
# upstream APIs all at once.
0 5 1 * * images:refresh:damnet
0 5 2 * * images:refresh:wikipedia
0 5 3 * * master:refresh:elevation
`;
