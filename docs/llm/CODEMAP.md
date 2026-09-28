# CODEMAP — file index

One-line summary of every source file. Skim this to locate code; jump to
the file for detail.

## Repo root

| Path | Purpose |
|---|---|
| `AGENTS.md` | LLM orientation; read first |
| `CLAUDE.md` | (in `~/.claude/`) workspace-global rules — coding style, git workflow |
| `package.json` | Bun workspace root; `lint` / `typecheck` / `test` / `e2e` scripts |
| `tsconfig.base.json` | shared strict TS config (NoUncheckedIndexedAccess, exactOptional) |
| `biome.json` | lint + format config |
| `playwright.config.ts` | spawns dev server on 3031 unless `E2E_BASE_URL` is set |
| `justfile` | infra + import + test recipes |
| `docker-compose.yml` | local Postgres (port 5433) + MinIO (9000) |
| `.env.example` | DATABASE_URL, S3_*, NEXT_PUBLIC_SITE_URL, API_AUTH_BYPASS |
| `.github/workflows/ci.yml` | lint+typecheck+migrate+unit+E2E with TimescaleDB-HA service |

## apps/web (Next.js)

### Pages

| Path | Renders |
|---|---|
| `app/layout.tsx` | nav + footer + metadata defaults |
| `app/page.tsx` | home: counts + 6 largest dams + map CTA |
| `app/dams/page.tsx` | dam list table with pref/watershed filter |
| `app/dams/[slug]/page.tsx` | dam detail (stat block, ObservationChart, watershed section, nearby) |
| `app/watersheds/page.tsx` | watershed list grouped by kind |
| `app/watersheds/[slug]/page.tsx` | watershed detail with aggregate + dam list |
| `app/prefectures/[code]/page.tsx` | prefecture-scoped dam list |
| `app/map/page.tsx` | server fetches all coords, JapanMap renders client-side |
| `app/sources/page.tsx` | data-source transparency table |
| `app/contribute/page.tsx` | contributor recruitment: history, live scale figures, stack, terms, credits |
| `app/api/docs/page.tsx` | Swagger UI on `/api/v1/openapi.json` |
| `app/sitemap.ts` | dynamic sitemap (dams + watersheds + prefectures) |
| `app/robots.ts` | allows everything except `/api/` |
| `app/not-found.tsx` | 404 page |
| `app/error.tsx` | client error boundary |

### API routes (all under `app/api/v1/`)

| Path | Method | Notes |
|---|---|---|
| `healthz/route.ts` | GET | DB ping; HAL+JSON; **no auth** |
| `sources/route.ts` | GET | source_priorities ⨝ raw_snapshots; **no auth** |
| `watershed/route.ts` | GET | point-in-polygon; auth required |
| `dams/route.ts` | GET | list with filter+cursor |
| `dams/[slug]/route.ts` | GET | detail + latest + nearby |
| `dams/[slug]/observations/route.ts` | GET | time-series (hourly/daily/monthly) |
| `watersheds/route.ts` | GET | list |
| `watersheds/[slug]/route.ts` | GET | detail |
| `watersheds/[slug]/aggregate/route.ts` | GET | totals |
| `watersheds/[slug]/dams/route.ts` | GET | scoped dam list |
| `prefectures/[code]/dams/route.ts` | GET | scoped dam list |
| `openapi.json/route.ts` | GET | OpenAPI 3.1 spec |

### Components

| File | Type | Used by |
|---|---|---|
| `components/nav.tsx` | server | layout |
| `components/breadcrumbs.tsx` | server (with JSON-LD) | every detail page |
| `components/dam-table.tsx` | server | /dams, /prefectures, /watersheds/[slug] |
| `components/dam-card.tsx` | server | home, /dams/[slug] (nearby + watershed) |
| `components/pagination.tsx` | server | /dams (cursor-based) |
| `components/quality-badge.tsx` | server | dam detail latest-obs header |
| `components/observation-chart.tsx` | **client** | dam detail; ECharts via dynamic import |
| `components/japan-map.tsx` | **client** | /map; Leaflet via dynamic import |

### Lib

| File | Purpose |
|---|---|
| `lib/api/auth.ts` | `authorize(req)` API key + per-key rate limit |
| `lib/api/error.ts` | HttpError + RFC 7807 problem+json response |
| `lib/api/response.ts` | `hal(body, links, init)` wraps JSON with HAL |
| `lib/api/pagination.ts` | `pageLinks` + RFC 5988 Link header |
| `lib/format.ts` | `fmtN`, `fmtPct`, `fmtDate`, `fmtCapacityMcm` |
| `lib/project-stats.ts` | hand-maintained codebase figures + stack table for `/contribute` (regen commands in the header) |
| `lib/contributors.ts` | permanent contributor credits list rendered at `/contribute#contributors` |

### One-off scripts (`apps/web/bin/`, run from repo root)

| File | Purpose |
|---|---|
| `import_real_ndi_w01.ts` | NLNI W01 (real schema) → `dams` master |
| `import_watersheds_from_w01.ts` | unique W01_003 names → `watersheds` master (boundary NULL) |
| `import_real_ndi_w07.ts` | per-mesh dissolved GeoJSONs → cross-mesh `boundary` backfill |
| `classify_watershed_kind.ts` | 水系域コード codelist + W05 区間種別 → `kind` / `ndi_code` migration (`bin/fetch_w05.sh` first) |
| `capture_damnet.ts` | probe `dambinran` post-id range → `dams.jsonl` |
| `match_damnet.ts` | match dams.jsonl → master, fill kana/manager/year, repair slugs |
| `repair_dam_slugs.ts` | recompute kana-romaji slugs after kana lands |
| `seed_synthetic_observations.ts` | 30 d hourly + ~5 yr daily synth → `observations` |

## apps/worker

| File | Purpose |
|---|---|
| `src/index.ts` | graphile-worker entry; registers tasks + crontab |
| `src/crontab.ts` | cron schedule (colon-separated task names); every `ingest:*` line carries `?jobKey=<task>` so a tick replaces its pending retry. `crontab.test.ts` checks each ingest line's key and that its retries (default 25 attempts) outlast its longest gap between runs, so no dead job is left behind per tick |
| `src/tasks/master_refresh_ndi.ts` | monthly NLNI reimport |
| `src/tasks/master_refresh_damnet.ts` | monthly damnet attribute pass |
| `src/tasks/master_match.ts` | `master:match`: placeholder, logs and returns (still on the nightly cron) |
| `src/tasks/ingest_kasenbosai.ts` | `ingest:kasenbosai`: original SourceAdapter run for 川の防災情報 (`packages/adapters/kasenbosai`); registered, not scheduled — `kasenbosai-v2` is the live feed |
| `src/tasks/ingest_kasenbosai_v2.ts` | `kasenbosai-v2`: hourly 川の防災情報 per-dam JSON for every `external_ids.kasenbosai` dam; a reading whose every quantity is flagged invalid is skipped, not stored empty |
| `src/tasks/ingest_shiga.ts` | `shiga-bousai`: hourly 滋賀県土木防災 dam stations, read only via `/mobile/dam/` (robots.txt disallows `/dam/`); level + flows, 6 h window re-upserted |
| `src/tasks/ingest_aomori.ts` | `aomori-dam`: hourly 青森県河川砂防 ダム諸量グラフ for every dam the ダム諸量現況表 lists (11 on 2026-09-27), not a fixed set |
| `src/tasks/ingest_nara_kasen.ts` | `nara-kasen`: hourly 奈良県 ダム現況表 (5 dams); volume stored as 有効 − 空容量 (usable), 大門's left null |
| `src/tasks/backfill_mudam.ts` | `backfill:mudam`: NILIM ダム諸量DB daily history (monthly tail + on demand); name + 10 km match, `MUDAM_OVERRIDES` pins mis-bound listings to an NDI id |
| `src/tasks/ingest_cgr_ashida_seki.ts` | `cgr-ashida-seki`: 福山河川国道事務所 芦田川河口堰 mobile page, hourly (level, volume, flows) |
| `src/tasks/ingest_cgr_okakawa.ts` | `cgr-okakawa-dam`: 岡山河川事務所 三水系主要ダム貯水状況 PDF, daily 9時 edition (11 dams + 2 weirs; only source for 小阪部川 / 坂根堰) |
| `src/tasks/ingest_awaji_suido.ts` | `awaji-suido`: 淡路広域水道企業団 各水源地の貯水状況, hand-edited about monthly, polled daily (淡路島 utility reservoirs; volume only, written when its comma grouping and volume / 貯水率 basis check out) |
| `src/tasks/ingest_hyogo_kigyo.ts` | `hyogo-kigyo`: 兵庫県企業庁 貯水状況, weekly 「M月D日現在」 table polled daily (神谷 volume + rate only; 黒川 企業庁 share, 平荘 / 権現 totals and live-covered rows universe-only) |
| `src/tasks/ingest_hyogo_suigen.ts` | `hyogo-suigen`: 兵庫県 県内の水源の状況, monthly 1日 survey (more often in a 渇水) polled daily; rate only, written for 千苅 / 丸山 / 加古川大堰 / 鴨川 (plus 呑吐 / 大川瀬 / 但東 when listed apart), dams with a volume feed elsewhere universe-only |
| `src/tasks/ingest_jwa_aichi_yosui.ts` | `jwa-aichi-yosui`: 愛知用水総合管理所 水情報, daily 0時 (牧尾 + 東郷調整池 / 前山池; 牧尾's daily-mean flows not stored) |
| `src/tasks/ingest_jwa_biwako.ts` | `jwa-biwako`: 琵琶湖総合管理所 堰諸量 JSON, hourly 24 h window (琵琶湖 level as T.P., 総流入 / 総流出; no volume) |
| `src/tasks/ingest_jwa_chikugo_rt.ts` | `jwa-chikugo-rt`: JWA 筑後川局 水管理情報WEB, hourly 24 h window (江川/寺内/小石原川/大山 + 筑後大堰; rate trusted, 0087) |
| `src/tasks/ingest_jwa_fukudou.ts` | `jwa-fukudou`: 福岡導水 山口調整池, daily 0時 (volume stored as 総 − 堆砂; rate null) |
| `src/tasks/ingest_jwa_tonekako.ts` | `jwa-tonekako`: 利根川河口堰 水位/流量 scripts, hourly 24 h window (Y.P. level + flows; only hours both tables carry) |
| `src/tasks/ingest_kagawa_tameike.ts` | `kagawa-tameike`: 香川県「かがわの水」daily PDF, ため池貯水率 of 26 named ponds (rate only, dated by survey), plus the page's 宝山湖 block (香川用水調整池, NDI 2170; rate only, stamped at the stated 時) |
| `src/tasks/ingest_kitakyushu_suido.ts` | `kitakyushu-suido`: 北九州市上下水道局 水源状況, daily (10 sources; rate trusted, 0098) |
| `src/tasks/ingest_kochi_kigyo.ts` | `kochi-kigyo`: 高知県公営企業局 ダム水文量表, hourly 48 h window (吉野 / 杉田 level + flows; empty hours dropped) |
| `src/tasks/ingest_kudamatsu_suido.ts` | `kudamatsu-suido`: 下松市上下水道局 水源情報, edited about monthly, polled daily (県営温見 level + volume + rate; 末武川 universe only) |
| `src/tasks/ingest_matsue_suido.ts` | `matsue-suido`: 松江市上下水道局 千本 / 大谷 daily 貯水量・貯水率 table |
| `src/tasks/ingest_mc_tottori_hydro.ts` | `mc-tottori-hydro`: M&C鳥取水力発電 運転情報, hourly (茗荷谷/三朝調整池/中津/菅沢 flows; gauge heights not stored) |
| `src/tasks/ingest_mie_kigyo.ts` | `mie-kigyo`: 三重県企業庁 水源状況, weekly table polled daily (伊坂 / 山村 / 菰野調整池; rate only where the printed 有効 is the master capacity, so 山村 volume-only) |
| `src/tasks/ingest_miyagi_nousei.ts` | `miyagi-nousei`: 宮城県農政部「農業用水の状況」PDF, surveyed 1日・15日 (monthly off-season), polled daily (17 dams + 9 ため池; rate trusted, 0097) |
| `src/tasks/ingest_nagano_kigyo.ts` | `nagano-kigyo`: 長野県企業局 10分諸量 JSON, :24 and :54 (4-row files; together all six 10-min rows) (高遠 / 菅平; priority 311 over kasenbosai's empty 高遠) |
| `src/tasks/ingest_nagasaki_city_suido.ts` | `nagasaki-city-suido`: 長崎市上下水道局 ダム貯水量一覧表, weekly, polled daily (浦上 volume + rate, pinned to 浦上（元） NDI 2602; other 12 rows universe only) |
| `src/tasks/ingest_sado_nourin.ts` | `sado-nourin`: 佐渡地域振興局 農業用ダム pages, polled daily (7 県営農業用ダム; volume + rate, trusted in 0097) |
| `src/tasks/ingest_sasebo_suido.ts` | `sasebo-suido`: 佐世保市水道局 daily 貯水状況 PDF (6 reservoirs; rate trusted, 0098) |
| `src/tasks/ingest_shimonoseki_suido.ts` | `shimonoseki-suido`: 下関市上下水道局 水源状況, daily poll of a 0時 table updated a few times a week (湯の原 written, rate trusted, 0107; 木屋川 / combined 内日貯水池 universe only) |
| `src/tasks/backfill_suimon_enqueue.ts` | `backfill:suimon:enqueue`: populate backfill_progress for 水文水質DB (manual) |
| `src/tasks/backfill_suimon_run.ts` | `backfill:suimon:run`: drain one batch of the suimon backfill queue (manual, not on the cron) |
| `src/tasks/quality_recompute.ts` | `quality:recompute`: nightly missing/mismatch flagging; nulls phantom zero-storage series |
| `src/tasks/aggregates_refresh.ts` | `aggregates:refresh`: refresh obs_daily / obs_monthly over full history (monthly, after the mudam tail) |
| `src/tasks/backfill_jwa_junpo.ts` | `backfill:jwa-junpo`: JWA past 旬報 archive for the 26 mapped dams, reusing the ingest_jwa_junpo parser (manual) |
| `src/tasks/backfill_kagoshima_bodik.ts` | `backfill:kagoshima-bodik`: 鹿児島県 BODIK ZIP archives, 10-min history 2008– for 大和 / 川辺 / 西之谷 (manual) |
| `src/tasks/ingest_aichi_kasen.ts` | `aichi-kasen`: 愛知県 川の防災情報 ダム表, hourly (雨山 / 木瀬) |
| `src/tasks/ingest_aitoyo.ts` | `aitoyo`: 愛知・豊川用水振興協会 daily 利水容量・貯水量・貯水率 table (7 dams in 木曽川 / 豊川 / 矢作川) |
| `src/tasks/ingest_akita_kasen.ts` | `akita-kasen`: 秋田県河川砂防情報システム 防災Web table, hourly (18 県管理ダム; no volume) |
| `src/tasks/ingest_cgr_mlit.ts` | `cgr-mlit-dam`: 中国地方整備局 dam dashboard JSON, hourly (11 国管理ダム); reference `recordUniverse` over a hardcoded array |
| `src/tasks/ingest_chiba.ts` | `chiba-suisei`: 千葉県水政課 県内ダムの貯水状況, weekly table polled daily (~23 水道 / 工業用水 dams; dated from the table heading) |
| `src/tasks/ingest_chiba_nourin.ts` | `chiba-nourin`: 千葉県耕地課 農業用ダム貯水状況, daily (11 dams) |
| `src/tasks/ingest_ehime_bousai.ts` | `ehime-bousai`: 愛媛県 河川・砂防情報システム ダム諸量経過表, hourly (12 dams, 24 h table each) |
| `src/tasks/ingest_fukui_bousai.ts` | `fukui-bousai`: 福井県 防災Web ダム諸量現況表, hourly (13 dams incl. 真名川 / 九頭竜) |
| `src/tasks/ingest_fukuoka_bodik.ts` | `fukuoka-bodik`: 福岡市水道局 dams via BODIK CSV, hourly (9 water-supply dams) |
| `src/tasks/ingest_fukushima_kasen.ts` | `fukushima-kasen`: 福島県河川流域総合情報システム dam JSON, hourly (11 県管理ダム) |
| `src/tasks/ingest_fukushima_nourin.ts` | `fukushima-nourin`: 福島県農林水産部 主要農業関係ダム貯水状況, daily (29 dams; rate only) |
| `src/tasks/ingest_gifu_kasen.ts` | `gifu-kasen`: 岐阜県 川の防災情報 ダム諸量, hourly (14 dams) |
| `src/tasks/ingest_gunma_kasen.ts` | `gunma-kasen`: 群馬県水位雨量情報システム ダム現況表, one page per dam, hourly (7 県管理ダム) |
| `src/tasks/ingest_hiroshima.ts` | `hiroshima-bousai`: 広島県防災Web pointer → list JSON, hourly |
| `src/tasks/ingest_hkd_mlit.ts` | `hkd-mlit-dam`: 北海道開発局 per-dam dashboards, hourly (18 国管理ダム) |
| `src/tasks/ingest_hrr_mlit.ts` | `hrr-mlit-dam`: 北陸地方整備局 `tmDam.txt`, hourly (7 dams; level + flows) |
| `src/tasks/ingest_hyogo.ts` | `hyogo-bodik`: 兵庫県 ダム諸量 BODIK CSV, hourly (22 stations) |
| `src/tasks/ingest_ibaraki_bousai.ts` | `ibaraki-bousai`: 茨城県河川防災情報 ダム諸量現況表, hourly (7 県管理ダム; no rate) |
| `src/tasks/ingest_ishikawa_kasen.ts` | `ishikawa-kasen`: 石川県河川総合情報システム dam JSON, hourly (11 県管理ダム) |
| `src/tasks/ingest_iwate_kasen.ts` | `iwate-kasen`: 岩手県河川情報システム ダム諸量経過表, one page per dam, hourly (10 県管理ダム) |
| `src/tasks/ingest_jwa_chiba.ts` | `jwa-chiba-bouso`: JWA 房総導水路管理所 取水情報, daily 0時 (長柄 / 東金; level + rate) |
| `src/tasks/ingest_jwa_chikugo.ts` | `jwa-chikugo`: JWA 筑後川 water-source page, daily 0時 (7 dams incl. 松原 / 下筌 / 合所) |
| `src/tasks/ingest_jwa_chubu.ts` | `jwa-chubu`: JWA 中部支社 水源状況 report, published once per weekday (木曽川水系 5 dams + 三重用水 中里); poll times in crontab.ts |
| `src/tasks/ingest_jwa_junpo.ts` | `jwa-junpo`: JWA 旬報 (10-day report), polled daily (26 JWA dams across 7 water systems) |
| `src/tasks/ingest_jwa_kiso_rt.ts` | `jwa-kiso-rt`: JWA 中部支社 木曽川水系 realtime page, hourly (6 dams) |
| `src/tasks/ingest_jwa_toneara.ts` | `jwa-toneara`: JWA 関東支社 利根川 / 荒川 daily 0時 table, polled hourly (13 facilities) |
| `src/tasks/ingest_jwa_toyokawa.ts` | `jwa-toyokawa`: JWA 中部支社 豊川水系 realtime page, hourly (宇連 / 大島) |
| `src/tasks/ingest_jwa_yoshino.ts` | `jwa-yoshino`: JWA 吉野川上流総合管理所 realtime page, hourly (5 dams; rate for 早明浦 only) |
| `src/tasks/ingest_kagawa_bousai.ts` | `kagawa-bousai`: かがわ防災Webポータル `dam_station.json`, hourly (18 dams) |
| `src/tasks/ingest_kagoshima_bousai.ts` | `kagoshima-bousai`: 鹿児島県防災ポータル `dam_station.json`, hourly; items only during flood events |
| `src/tasks/ingest_kagoshima_kasen.ts` | `kagoshima-kasen`: 鹿児島県河川砂防情報システム ダム一覧表, hourly (西之谷 / 川辺 / 大和) |
| `src/tasks/ingest_kanagawa.ts` | `kanagawa-dam`: かながわの水がめ `summary.php` JSON, hourly (5 dams) |
| `src/tasks/ingest_kkr_mlit.ts` | `kkr-mlit-dam`: 近畿地方整備局 貯水率 JSON feed, daily (12 国管理ダム) |
| `src/tasks/ingest_kochi_bousai.ts` | `kochi-bousai`: 高知県水防情報システム ダム諸量現況表, hourly (11 dams: 7 県 + 4 MLIT) |
| `src/tasks/ingest_ktr_kinu.ts` | `ktr-kinu-dam`: 関東地方整備局 鬼怒川ダム統合管理事務所 realtime page, hourly (4 dams) |
| `src/tasks/ingest_ktr_tone_dam.ts` | `ktr-tone-dam`: 関東地方整備局 利根川ダム統合管理事務所 JSON, hourly (9 dams) |
| `src/tasks/ingest_kumamoto_bousai.ts` | `kumamoto-bousai`: 熊本県防災情報システム 地方別ダム情報, hourly (6 dams; 利水容量 rate preferred) |
| `src/tasks/ingest_kyoto_bousai.ts` | `kyoto-bousai`: 京都府 河川防災情報 ダム諸量現況表, hourly (6 dams; 瀬田洗堰 recorded in the universe unresolved) |
| `src/tasks/ingest_kyushu_nousei.ts` | `kyushu-nousei`: 九州農政局 農業用ダムの貯水状況 PDF (link discovered each run), daily (59 dams across 九州) |
| `src/tasks/ingest_miyagi_kasen.ts` | `miyagi-kasen`: 宮城県土木総合情報システム ダム現況表, latest + previous hour, hourly (21 dams) |
| `src/tasks/ingest_miyazaki_bousai.ts` | `miyazaki-bousai`: 宮崎県 防災Web ダム諸量現況表, hourly (13 県管理ダム) |
| `src/tasks/ingest_nagano_kasen.ts` | `nagano-kasen`: 長野県 河川砂防情報ステーション dam JSON, hourly (17 県管理ダム) |
| `src/tasks/ingest_nagasaki_kasen.ts` | `nagasaki-kasen`: 長崎県河川砂防情報 dam JSON, every 30 min (35 dams; 利水 rate) |
| `src/tasks/ingest_oita_bousai.ts` | `oita-bousai`: 大分県河川情報 防災Web ダム諸量現況表, hourly (10 県管理ダム) |
| `src/tasks/ingest_oita_nourin.ts` | `oita-nourin`: 大分県 農業用ダム貯水率一覧 PDF (link discovered each run), daily (21 dams) |
| `src/tasks/ingest_okayama.ts` | `okayama-bousai`: おかやま防災ポータル pointer → list JSON, hourly (21 dams listed); reference `recordUniverse` over a fetched list |
| `src/tasks/ingest_okinawa_eb.ts` | `okinawa-eb`: 沖縄県企業局 `dam-youryou.csv`, daily (倉敷 / 山城) |
| `src/tasks/ingest_osaka.ts` | `osaka-bousai`: 大阪府河川防災情報 `choryuryo.json`, dams only (typeId 3), hourly (安威川 / 箕面川 / 狭山池) |
| `src/tasks/ingest_qsr_ryumon.ts` | `qsr-ryumon-dam`: 九州地方整備局 竜門ダム key-value endpoints, hourly |
| `src/tasks/ingest_qsr_toukan.ts` | `qsr-toukan-dam`: 九州地方整備局 筑後川ダム統合管理事務所, hourly (松原 / 下筌) |
| `src/tasks/ingest_qsr_turuta.ts` | `qsr-turuta-dam`: 九州地方整備局 鶴田ダム EUC-JP table, hourly |
| `src/tasks/ingest_saga_bousai.ts` | `saga-bousai`: 佐賀県河川砂防情報システム transposed ダム現況表 (3 pages), hourly (19 県管理ダム) |
| `src/tasks/ingest_saitama_suibo.ts` | `saitama-suibo`: 埼玉県 川の防災情報 `dinfo.csv`, hourly (9 dams / 調節池) |
| `src/tasks/ingest_shimane_bousai.ts` | `shimane-bousai`: 島根県水防情報システム `dam60.json`, hourly (19 dams) |
| `src/tasks/ingest_shimokubo.ts` | `shimokubo`: JWA 下久保ダム `table.json`, hourly (10-min readings) |
| `src/tasks/ingest_skr_hiji.ts` | `skr-hiji-dam`: 四国地方整備局 肱川 dams via www1.river.go.jp DspDamData, hourly (野村 / 鹿野川) |
| `src/tasks/ingest_syowaike.ts` | `syowaike`: 兵庫県 昭和池防災情報管理システム テレメータ snapshot, hourly (昭和池, NDI 1539 pinned; level + m³ volume + inflow + rain) |
| `src/tasks/ingest_tndam_hyogo.ts` | `tndam-hyogo`: 兵庫県 丹波農林振興事務所 ダムテレメータ, latest reading per dam, hourly (6 dams) |
| `src/tasks/ingest_tochigi.ts` | `tochigi-bodik`: 栃木県 ダム諸量 BODIK CSV (NGSI-v2 shape), hourly |
| `src/tasks/ingest_tokushima_bousai.ts` | `tokushima-bousai`: 徳島県 ダム諸量情報, hourly (7 dams; level + flows) |
| `src/tasks/ingest_tokyo_waterworks.ts` | `tokyo-waterworks`: 東京都水道局 水源状況 daily table, polled twice a day (利根川 / 荒川 / 多摩川 dams) |
| `src/tasks/ingest_tottori.ts` | `tottori-dam`: 鳥取県ダム諸量情報システム `data10all.php`, hourly (5 県管理ダム) |
| `src/tasks/ingest_tottori_bousai.ts` | `tottori-bousai`: 鳥取県防災Web pointer → list JSON, hourly (6 dams; adds 菅沢) |
| `src/tasks/ingest_toyama_bousai.ts` | `toyama-bousai`: 富山県 河川現況表 dam CSVs, hourly (16 県管理ダム) |
| `src/tasks/ingest_wakayama_kasen.ts` | `wakayama-kasen`: 和歌山県河川／雨量防災情報 `dinfo.csv` (EUC-JP), hourly (19 dams) |
| `src/tasks/ingest_yamagata_bousai.ts` | `yamagata-bousai`: 山形県河川・砂防情報 防災Web JSON, hourly (~17 dams: 13 県 + 4 国) |
| `src/tasks/ingest_yamaguchi_bousai.ts` | `yamaguchi-bousai`: 山口県土木防災情報システム, one page per dam (24 h at 10 min), hourly (23 dams) |
| `src/tasks/ingest_yamanashi_dam.ts` | `yamanashi-dam`: 山梨県雨量・水位情報 ダム状況表, hourly (6 県管理ダム) |
| `src/tasks/match_kasenbosai.ts` | `match:kasenbosai`: weekly sweep of the 川の防災情報 dam catalogue (~900 dams); seeds `external_ids.kasenbosai` and records kasenbosai's universe |
| `src/tasks/match_kasenbosai_scoring.ts` | pure scoring tiers for match_kasenbosai (name / containment / trigram / distance); not a task |
| `src/tasks/observations_rebind.ts` | `observations:rebind`: move one source's observations to the right dam, keyed by NDI id (manual) |
| `src/tasks/quality_freshness.ts` | `quality:freshness-check`: hourly stale-source digest to Discord (or the log) |
| `src/tasks/refresh_dam_elevation.ts` | `master:refresh:elevation`: fill NULL `elevation_m` from the GSI DEM API (monthly) |
| `src/tasks/refresh_dam_images_wikipedia.ts` | `images:refresh:wikipedia`: ja.wikipedia page image for dams without a Damnet photo (monthly) |
| `src/tasks/storage_rate_recompute.ts` | `storageRate:recompute`: nightly fill of rates for rows with a volume but no rate, one transaction per chunk |

## packages/core (zero dependencies)

| File | Public exports |
|---|---|
| `src/slug.ts` | `toSlug`, `suffixedSlug` |
| `src/prefectures.ts` | `PREFECTURES` array, `prefNameToCode` |
| `src/source_adapter.ts` | `SourceAdapter`, `FetchTarget`, `RawBytes`, `ParsedReading`, `FetchContext` |
| `src/http_client.ts` | `HttpClient` (throttle + retry + ETag) |
| `src/hateoas.ts` | `buildLinks`, `Link`, `LinksInput` |
| `src/similarity.ts` | `trigramSimilarity`, `normalizeJaName` |
| `src/dam_binding.ts` | `BindableMaster`, `twinOf`, `preferMaster`, `stampedMaster`, `chooseRanked` (station → master: a stamped row keeps it, then lowest SQL rank, （元）/（再） tie-break) |

## packages/db

### Migrations

```
0000_extensions.sql          postgis, timescaledb, pgcrypto, pg_trgm
0001_master.sql              dams, watersheds, rivers, match_review + updated_at trigger
0002_indexes.sql             GiST on geom, GIN on trigram, btree on filters
0003_external_ids_unique.sql partial unique idx for external_ids->>'ndi' and ->>'damnet'
0010_graphile_worker.sql     placeholder; graphile-worker installs its own schema on 1st run
0011_observations.sql        hypertable; PK (dam_id, observed_at, source_id)
0012_raw_snapshots.sql       raw ledger + FK from observations
0013_source_priorities.sql   seed (kasenbosai 100, suimon 90, ndi 80, damnet 50)
0014_observation_indexes.sql btree (dam_id, observed_at) + columnar compression policy
0015_continuous_aggregates.sql obs_daily, obs_monthly with refresh policies
0016_backfill_progress.sql   year×dam queue with status
0017_api_keys.sql            api_keys (sha256 hash) + api_key_usage (per-minute bucket)
0018_watersheds_boundary_nullable.sql  ALTER … DROP NOT NULL on boundary
0020_quality_view.sql        quality_missing_24h view
```

### Schemas

| File | Mirrors |
|---|---|
| `src/schema/dams.ts` | `dams` |
| `src/schema/watersheds.ts` | `watersheds` |
| `src/schema/rivers.ts` | `rivers` |
| `src/schema/match_review.ts` | `match_review` |
| `src/schema/observations.ts` | `observations` (hypertable) |
| `src/schema/raw_snapshots.ts` | `raw_snapshots` |
| `src/schema/source_priorities.ts` | `source_priorities` |
| `src/schema/backfill_progress.ts` | `backfill_progress` |
| `src/schema/api_keys.ts` | `api_keys`, `api_key_usage` |
| `src/schema/index.ts` | re-exports all of the above |

### Repositories

| File | Functions |
|---|---|
| `src/repo/dams.ts` | `upsertDamByExternalId`, `findDamBySlug`, `latestObservation`, `nearbyDams`, `listDams` (orderBy: id\|capacity), `takenSlugs`, `appendExternalId`, `applyDamnetAttributes`, `findDamsForReconciliation` |
| `src/repo/watersheds.ts` | `upsertWatershed`, `findWatershedBySlug`, `findWatershedContaining`, `findNearestWatershed`, `listWatersheds`, `aggregateWatershed` |
| `src/repo/match_review.ts` | `enqueueMatchReview` |
| `src/repo/observations.ts` | `upsertObservations`, `findSeries{Hourly,Daily,Monthly}` |
| `src/repo/raw_snapshots.ts` | `recordRawSnapshot`, `markParsed`, `markParseError`, `previousEtag` |
| `src/repo/source_priorities.ts` | `preferredSource`, `priorityMap` |
| `src/repo/backfill_progress.ts` | `nextPending`, `startRunning`, `complete`, `fail`, `enqueueAllDams` |
| `src/repo/api_keys.ts` | `issueKey`, `lookupByPrefix`, `revoke`, `recordUsage`, `usageInLastMinute`, `usageToday`, `hashKey`, `touchLastUsed` |
| `src/migrate.ts` | numbered-SQL runner, ENOENT-tolerant |
| `src/client.ts` | postgres.js singleton with bigint round-trip |

## packages/storage

| File | Purpose |
|---|---|
| `src/client.ts` | S3Client configured for MinIO (path-style URLs) |
| `src/snapshot_store.ts` | `rawSnapshotKey`, `putSnapshot`, `getSnapshot` |

## packages/ingest

| File | Purpose |
|---|---|
| `src/pipeline.ts` | `runIngestForAdapter(adapter, ctx)` end-to-end |
| `src/quality.ts` | `QualityFlag` bits, `isPhysicallyValid`, `detectOutlier` |

## packages/reconciler

| File | Purpose |
|---|---|
| `src/score.ts` | `scoreCandidate({nameSim, distanceM, managerMatch})` weighted score |
| `src/match.ts` | `matchDam(record)` candidate query + scoring + threshold |

## packages/adapters

| Subdir | Conforms to SourceAdapter? | Schedule | Notes |
|---|---|---|---|
| `ndi/` | yes (T8 of Plan 4) | on-demand | W01 dams + W07 watershed boundaries |
| `damnet/` | yes | on-demand | Old `damnet.or.jp` adapter; the live data comes from `bin/capture_damnet.ts` against the new `dambinran.damnet.or.jp` JSON API |
| `kasenbosai/` | yes | hourly | XML parser; production endpoint blocks scrapers (synthetic seed in use) |
| `suimon/` | yes | on-demand | CSV parser; deferred (EUC-JP HTML form) |

## tests

| Path | What it covers |
|---|---|
| `packages/*/src/**/*.test.ts` | unit + integration; 85 tests, 26 files |
| `tests/integration/helpers.ts` | `withTestDb` per-call transaction helper |
| `tests/e2e/api.spec.ts` | HAL+JSON shape, sitemap, robots, 400/404 |
| `tests/e2e/home.spec.ts` | home headline + nav |
| `tests/e2e/dams.spec.ts` | list + detail + 404 + structured data |
| `tests/e2e/watersheds.spec.ts` | list + detail + prefecture |
| `tests/e2e/qa-walk.spec.ts` | full-page screenshot + console-error scan over 12 pages |

## docs

| Path | Audience |
|---|---|
| `AGENTS.md` | LLM agents (read first) |
| `docs/llm/PROJECT_OVERVIEW.md` | architecture in two pages |
| `docs/llm/CODEMAP.md` | this file |
| `docs/llm/DATA_FLOW.md` | how facts move from upstream to chart |
| `docs/llm/RUNBOOK.md` | operations (deploy, restart, restore, debug) |
| `docs/llm/CONVENTIONS.md` | coding style, commit format, test patterns |
| `docs/superpowers/specs/*` | product/architecture (canonical) |
| `docs/superpowers/plans/*` | implementation plans |

## deploy

| Path | Purpose |
|---|---|
| `deploy/coolify/Dockerfile.web` | multi-stage Bun build for Next |
| `deploy/coolify/Dockerfile.worker` | thin Bun image for graphile-worker |
| `deploy/coolify/docker-compose.coolify.yml` | full stack with healthchecks |
| `deploy/coolify/README.md` | first-time bring-up |
| `deploy/backup/pgbackrest.conf` | full+diff schedule, S3 destination, AES-256 |
| `deploy/ops/runbook.md` | operator runbook |
| `deploy/ops/oneoff/*.sql` | dated one-off data fixes on compressed `observations` (never migrations); see runbook §9 |
