// Coverage triage (GLOSSARY): why each dam does or does not have data, and
// the coverage numbers the site quotes, all from one snapshot.
//
// - `triageDams(ids?)` is the one definition of a dam's coverage status, for
//   every dam or a set of them (the dam page asks for one).
// - `coverageSnapshot()` runs it once for every dam and derives the headline,
//   the summary and the per-prefecture numbers from that same result, so the
//   figures on one page cannot disagree mid-ingest.
// - The status vocabulary (labels, meanings) lives here too; the API, the
//   OpenAPI document and the pages take it from here.
//
// "A value" is `observation_has_value(o)` and the source gate is the view
// `coverage_gate_sources` (migration 0225), shared with every other query.

import { sql } from '../client.ts';

export const COVERAGE_STATUSES = [
  'covered',
  'published_not_ingested',
  'published_no_data',
  'unknown',
  'not_published',
] as const;

export type DamCoverageStatus = (typeof COVERAGE_STATUSES)[number];

/** How each status reads, on the site and in the API. */
export const COVERAGE_STATUS: Readonly<
  Record<DamCoverageStatus, { readonly label: string; readonly meaning: string }>
> = {
  covered: {
    label: '取得済み',
    meaning:
      '直近 30 日に観測値がある。月次・不定期の提供元は、公開中の最新値 (提供元自身の日付) を取り込み済み。',
  },
  published_not_ingested: {
    label: '公開されているが未取得',
    meaning:
      'データ提供元が公開しており、マスタとの紐付けも済んでいるのに観測値が入っていない。取り込み側の不具合で、こちらで直せる。',
  },
  published_no_data: {
    label: '提供元に値なし',
    meaning:
      'データ提供元の公開一覧には載っているが、掲載しているすべての提供元が使える値を出していない (調査対象外、全項目が欠測表示、落水中の 0.0 % など、提供元自身が空と示している)。取り込み側で直せるものは無い。',
  },
  unknown: {
    label: '未調査',
    meaning: '公開一覧をまだ記録していないデータ提供元が残っているため、提供の有無を判定できない。',
  },
  not_published: {
    label: '提供元なし',
    meaning:
      '観測値を出す全提供元の公開一覧を記録した上で、どこにも現れなかった。ただし公開一覧を列挙できない提供元と、定期スキャンを持たない歴史ダンプは判定から除外しているため、その分の保留が残る。',
  },
};

/**
 * Whether a data provider publishes the dam, as one word for readers and API
 * clients: `available` (a provider publishes it, values or not), `none`
 * (提供元なし: every provider's list was recorded and none carries it) or
 * `unknown` (some provider's list is not recorded yet).
 */
export const PROVIDER_AVAILABILITIES = ['available', 'none', 'unknown'] as const;
export type ProviderAvailability = (typeof PROVIDER_AVAILABILITIES)[number];

export const PROVIDER_AVAILABILITY_LABEL: Readonly<Record<ProviderAvailability, string>> = {
  available: '提供元あり',
  none: '提供元なし',
  unknown: '提供元: 未調査',
};

export function providerAvailability(status: DamCoverageStatus): ProviderAvailability {
  if (status === 'not_published') return 'none';
  if (status === 'unknown') return 'unknown';
  return 'available';
}

/**
 * Not data we could be missing: nobody publishes the dam, or everyone who
 * lists it marks it empty. Such dams are in no coverage denominator.
 */
export function isUnobtainable(status: DamCoverageStatus): boolean {
  return status === 'not_published' || status === 'published_no_data';
}

export interface DamCoverageRow {
  damId: bigint;
  slug: string;
  name: string;
  prefCode: string | null;
  status: DamCoverageStatus;
  /** Sources whose published list contains this dam. */
  publishedBy: string[];
}

/**
 * Per-dam answer to "is this dam's data published and we're failing to get
 * it, or does nobody publish it?", for every dam or only `ids`.
 *
 * The `unknown` rung is the point of the whole design. A dam absent from
 * `source_universe` only means "nobody publishes it" once every source in
 * `coverage_gate_sources` has recorded a scan; while any is unscanned,
 * absence proves nothing and the dam reports `unknown`.
 *
 * Caveats, surfaced in the summary rather than hidden:
 *  - `sourcesNotEnumerable` — providers that publish no station list at all
 *    (a portal that lists dams only during a flood event), outside the gate.
 *  - `sourcesHistoricalOnly` — dumps and backfill-only sources with no
 *    recurring scan to record, outside the gate for the same reason.
 *
 * A retired source counts nowhere: not in the gate, since it will never scan
 * again, and not as a publisher, since a dam only it lists is not an
 * ingestion bug we can fix.
 */
export async function triageDams(ids?: readonly bigint[]): Promise<DamCoverageRow[]> {
  // Null scope = every dam. The parameter is bound with its value at plan
  // time (unnamed statements), so `NULL IS NULL` folds away for the full run
  // and an id list becomes an index probe.
  const scope = ids ? ids.map((id) => id.toString()) : null;
  return sql<DamCoverageRow[]>`
    WITH pending AS (
      SELECT COUNT(*)::INT AS n
      FROM coverage_gate_sources g
      WHERE NOT EXISTS (SELECT 1 FROM source_universe_runs r WHERE r.source_id = g.source_id)
    ),
    fresh AS (
      SELECT o.dam_id
      FROM observations o
      WHERE o.observed_at > NOW() - INTERVAL '30 days'
        AND o.source_id <> 'synthetic'
        AND observation_has_value(o)
        AND (${scope}::BIGINT[] IS NULL OR o.dam_id = ANY(${scope}::BIGINT[]))
      UNION
      -- We hold the newest value a dated provider publishes (0221), however
      -- old: a monthly survey has nothing newer to take. Only a scan from the
      -- last 7 days vouches for that date. A LATERAL ... LIMIT 1 probe, not
      -- EXISTS: the planner turned the EXISTS into a Hash Semi Join that
      -- hashed every observation and spilled ~335 MB of temp files (#105).
      SELECT su.resolved_dam_id
      FROM source_universe su
      CROSS JOIN LATERAL (
        SELECT 1
        FROM observations o
        WHERE o.dam_id = su.resolved_dam_id
          AND o.source_id = su.source_id
          AND o.observed_at >= su.published_at
          AND observation_has_value(o)
        LIMIT 1
      ) hit
      WHERE su.resolved_dam_id IS NOT NULL
        AND su.published_at IS NOT NULL
        AND su.last_seen_at > NOW() - INTERVAL '7 days'
        AND (${scope}::BIGINT[] IS NULL OR su.resolved_dam_id = ANY(${scope}::BIGINT[]))
    ),
    published AS (
      SELECT su.resolved_dam_id AS dam_id,
             ARRAY_AGG(DISTINCT su.source_id ORDER BY su.source_id) AS sources,
             -- Every listing row says empty. A single unknown (NULL) row could
             -- be the source we are failing to ingest, so it keeps the dam out.
             BOOL_AND(su.has_data IS FALSE) AS no_data
      FROM source_universe su
      WHERE su.resolved_dam_id IS NOT NULL
        AND (${scope}::BIGINT[] IS NULL OR su.resolved_dam_id = ANY(${scope}::BIGINT[]))
        AND NOT EXISTS (
          SELECT 1 FROM source_priorities sp WHERE sp.source_id = su.source_id AND NOT sp.active
        )
      GROUP BY su.resolved_dam_id
    )
    SELECT d.id                        AS "damId",
           d.slug                      AS "slug",
           d.name                      AS "name",
           d.pref_code                 AS "prefCode",
           CASE
             WHEN f.dam_id IS NOT NULL          THEN 'covered'
             WHEN p.no_data                     THEN 'published_no_data'
             WHEN p.dam_id IS NOT NULL          THEN 'published_not_ingested'
             WHEN (SELECT n FROM pending) > 0   THEN 'unknown'
             ELSE 'not_published'
           END                         AS "status",
           COALESCE(p.sources, ARRAY[]::TEXT[]) AS "publishedBy"
    FROM dams d
    LEFT JOIN fresh f ON f.dam_id = d.id
    LEFT JOIN published p ON p.dam_id = d.id
    WHERE ${scope}::BIGINT[] IS NULL OR d.id = ANY(${scope}::BIGINT[])
    ORDER BY d.id
  `;
}

/** `triageDams` for one dam (the dam page, its Markdown and its API record). */
export async function triageDam(id: bigint): Promise<DamCoverageRow | null> {
  const [row] = await triageDams([id]);
  return row ?? null;
}

/**
 * The site quotes two different coverage numbers and they answer two
 * different questions:
 *
 * - `realtimeDamCount` — dams the triage calls `covered`. A source that only
 *   publishes 水位 or 雨量 still counts.
 * - `storageRateRiverDamCount` / `riverDamCount` — dams we can actually show
 *   a 貯水率 for in the last 30 days, over the dams the ダム法 calls a dam
 *   (堤高 15 m 以上).
 *
 * Dams there is nothing to obtain for are in no denominator: 提供元なし and
 * 提供元に値なし. They are also out of the 歴史データ numerator, so that
 * metric shares the same population. While the gate is open no dam is
 * 提供元なし.
 */
export interface CoverageHeadline {
  /** Every master row, including 堤高 15 m 未満 のため池など. */
  damTotal: number;
  /** Dams classified `covered`. */
  realtimeDamCount: number;
  /** Dams with a value at any time (mudam history counts), unobtainable dams excluded. */
  historicalDamCount: number;
  /** 河川管理ダム: 堤高 15 m 以上. */
  riverDamCount: number;
  /** River dams with a 貯水率 in the last 30 days — the numerator. */
  storageRateRiverDamCount: number;
  /** 提供元なし dams, out of the 実測 and 歴史 denominators. */
  notPublishedDamCount: number;
  /** 提供元に値なし dams, out of the 実測 and 歴史 denominators. */
  publishedNoDataDamCount: number;
  /** River dams of either kind, out of the 貯水率 denominator. */
  unobtainableRiverDamCount: number;
}

/** ダム法の定義: 堤高 15 m 以上. */
export const RIVER_DAM_MIN_HEIGHT_M = 15;

/**
 * Why a provider has not recorded its published list yet, from what the
 * database can see. "Recent" is the triage's 30 days.
 *  - `no_recent_observations` — nothing from it landed recently: its task
 *    has not run yet or is failing.
 *  - `ingesting_without_list` — observations arrive, but no list was ever
 *    stamped (every scan listed nothing, which does not count as a scan).
 */
export type PendingScanReason = 'no_recent_observations' | 'ingesting_without_list';

export interface PendingScanSource {
  sourceId: string;
  reason: PendingScanReason;
}

export interface CoverageSummary {
  covered: number;
  publishedNotIngested: number;
  publishedNoData: number;
  unknown: number;
  notPublished: number;
  /**
   * Published stations we cannot tie to any master dam — the backlog.
   * Excludes rows a migration marked `not_dam_reason`.
   */
  unmatchedStations: number;
  /** Unresolved stations carrying a cited `not_dam_reason`; out of the backlog. */
  notDamStations: number;
  /** Gate sources with no recorded scan. While > 0, `unknown` is not `not_published`. */
  sourcesPendingScan: number;
  pendingScanSources: PendingScanSource[];
  /** Observation providers that publish no enumerable list; outside the gate. */
  sourcesNotEnumerable: number;
  /** Dumps and backfill-only sources; outside the gate. */
  sourcesHistoricalOnly: number;
}

export interface PrefectureCoverage {
  prefCode: string;
  /** Dams there is something to obtain for. */
  damTotal: number;
  damsCovered: number;
}

export interface CoverageSnapshot {
  dams: DamCoverageRow[];
  headline: CoverageHeadline;
  summary: CoverageSummary;
  prefectures: PrefectureCoverage[];
}

async function headlineOf(dams: readonly DamCoverageRow[]): Promise<CoverageHeadline> {
  const excluded = dams.filter((r) => isUnobtainable(r.status)).map((r) => r.damId.toString());
  const [row] = await sql<
    Pick<
      CoverageHeadline,
      | 'damTotal'
      | 'historicalDamCount'
      | 'riverDamCount'
      | 'storageRateRiverDamCount'
      | 'unobtainableRiverDamCount'
    >[]
  >`
    WITH excluded AS (SELECT UNNEST(${excluded}::BIGINT[]) AS id)
    SELECT
      (SELECT COUNT(*)::INT FROM dams)                                   AS "damTotal",
      (SELECT COUNT(DISTINCT o.dam_id)::INT
         FROM observations o
         WHERE o.source_id <> 'synthetic'
           AND o.dam_id NOT IN (SELECT id FROM excluded)
           AND observation_has_value(o))                                 AS "historicalDamCount",
      (SELECT COUNT(*)::INT
         FROM dams
         WHERE height_m >= ${RIVER_DAM_MIN_HEIGHT_M})                    AS "riverDamCount",
      (SELECT COUNT(DISTINCT o.dam_id)::INT
         FROM observations o
         JOIN dams d ON d.id = o.dam_id
         WHERE d.height_m >= ${RIVER_DAM_MIN_HEIGHT_M}
           AND o.observed_at > NOW() - INTERVAL '30 days'
           AND o.source_id <> 'synthetic'
           AND o.storage_rate IS NOT NULL)                               AS "storageRateRiverDamCount",
      (SELECT COUNT(*)::INT
         FROM dams
         WHERE height_m >= ${RIVER_DAM_MIN_HEIGHT_M}
           AND id IN (SELECT id FROM excluded))                         AS "unobtainableRiverDamCount"
  `;
  if (!row) throw new Error('coverage headline returned no row');
  return {
    ...row,
    realtimeDamCount: dams.filter((r) => r.status === 'covered').length,
    notPublishedDamCount: dams.filter((r) => r.status === 'not_published').length,
    publishedNoDataDamCount: dams.filter((r) => r.status === 'published_no_data').length,
  };
}

async function summaryOf(dams: readonly DamCoverageRow[]): Promise<CoverageSummary> {
  const count = (s: DamCoverageStatus): number => dams.filter((r) => r.status === s).length;
  const [extra] = await sql<
    { unresolved: bigint; not_dam: bigint; not_enumerable: bigint; historical_only: bigint }[]
  >`
    SELECT
      (SELECT COUNT(*) FROM source_universe su
        WHERE su.resolved_dam_id IS NULL
          AND su.not_dam_reason IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM source_priorities sp WHERE sp.source_id = su.source_id AND NOT sp.active
          )
      )::BIGINT AS unresolved,
      (SELECT COUNT(*) FROM source_universe su
        WHERE su.resolved_dam_id IS NULL
          AND su.not_dam_reason IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM source_priorities sp WHERE sp.source_id = su.source_id AND NOT sp.active
          )
      )::BIGINT AS not_dam,
      (SELECT COUNT(*) FROM source_priorities sp
        WHERE sp.active AND sp.provides_observations AND NOT sp.universe_enumerable
      )::BIGINT AS not_enumerable,
      (SELECT COUNT(*) FROM source_priorities sp
        WHERE sp.active AND sp.provides_observations AND sp.historical_only
      )::BIGINT AS historical_only
  `;
  // The probe is windowed on purpose: an unbounded EXISTS for a source with
  // no rows must visit every chunk, compressed ones included (~125 ms per
  // source on prod against ~7 ms for 30 days).
  const pending = await sql<PendingScanSource[]>`
    SELECT g.source_id AS "sourceId",
           CASE WHEN EXISTS (
                  SELECT 1 FROM observations o
                  WHERE o.source_id = g.source_id
                    AND o.observed_at > NOW() - INTERVAL '30 days'
                )
                THEN 'ingesting_without_list'
                ELSE 'no_recent_observations'
           END AS "reason"
    FROM coverage_gate_sources g
    WHERE NOT EXISTS (SELECT 1 FROM source_universe_runs r WHERE r.source_id = g.source_id)
    ORDER BY g.source_id
  `;
  return {
    covered: count('covered'),
    publishedNotIngested: count('published_not_ingested'),
    publishedNoData: count('published_no_data'),
    unknown: count('unknown'),
    notPublished: count('not_published'),
    unmatchedStations: Number(extra?.unresolved ?? 0),
    notDamStations: Number(extra?.not_dam ?? 0),
    sourcesPendingScan: pending.length,
    pendingScanSources: [...pending],
    sourcesNotEnumerable: Number(extra?.not_enumerable ?? 0),
    sourcesHistoricalOnly: Number(extra?.historical_only ?? 0),
  };
}

/** Same denominator as the headline: unobtainable dams are in no prefecture's total. */
function prefecturesOf(dams: readonly DamCoverageRow[]): PrefectureCoverage[] {
  const byPref = new Map<string, PrefectureCoverage>();
  for (const r of dams) {
    if (r.prefCode == null || isUnobtainable(r.status)) continue;
    const p = byPref.get(r.prefCode) ?? { prefCode: r.prefCode, damTotal: 0, damsCovered: 0 };
    p.damTotal += 1;
    if (r.status === 'covered') p.damsCovered += 1;
    byPref.set(r.prefCode, p);
  }
  return [...byPref.values()];
}

/** One triage of every dam, and every coverage figure derived from it. */
export async function coverageSnapshot(): Promise<CoverageSnapshot> {
  const dams = await triageDams();
  const [headline, summary] = await Promise.all([headlineOf(dams), summaryOf(dams)]);
  return { dams, headline, summary, prefectures: prefecturesOf(dams) };
}

function share(numerator: number, denominator: number): number | null {
  return denominator > 0 ? (numerator / denominator) * 100 : null;
}

/** Dams there is something to obtain for: the 実測 and 歴史 denominator. */
export function coverageDamTotal(c: CoverageHeadline): number {
  return c.damTotal - c.notPublishedDamCount - c.publishedNoDataDamCount;
}

/** River dams there is something to obtain for: the 貯水率 denominator. */
export function coverageRiverDamCount(c: CoverageHeadline): number {
  return c.riverDamCount - c.unobtainableRiverDamCount;
}

/** 貯水率が取れているダムの割合 [0..100]. Null when the denominator is empty. */
export function storageRateCoveragePct(c: CoverageHeadline): number | null {
  return share(c.storageRateRiverDamCount, coverageRiverDamCount(c));
}

/** 取得できるダムのうち、何らかの実測を取得済みの割合 [0..100]. */
export function realtimeCoveragePct(c: CoverageHeadline): number | null {
  return share(c.realtimeDamCount, coverageDamTotal(c));
}

/** 過去に一度でも実測があった割合 [0..100]. */
export function historicalCoveragePct(c: CoverageHeadline): number | null {
  return share(c.historicalDamCount, coverageDamTotal(c));
}
