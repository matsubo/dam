-- Two definitions that were restated wherever they were needed (GLOSSARY:
-- Value; Coverage triage).
--
-- observation_has_value(o): an observation that carries at least one of
-- 貯水量, 貯水率, 流入量, 放流量, 水位, 雨量. A row with none of them is not
-- data, whatever its timestamp (mudam's blank CSV days, kasenbosai's
-- all-欠測 hours were stored that way). A plain SQL function, so the planner
-- inlines it: `observation_has_value(o)` plans exactly like the num_nonnulls
-- it replaces, chunk exclusion included.
--
-- coverage_gate_sources: the sources whose published list must be recorded
-- before /coverage may call a dam 提供元なし — active, observation-providing,
-- enumerable, scanned on a schedule. A source outside it (retired, master
-- data only, a flood-only portal, a historical dump) never holds the gate.

CREATE FUNCTION observation_has_value(o observations) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT num_nonnulls(o.storage_volume_m3, o.storage_rate, o.inflow_m3s,
                      o.outflow_m3s, o.water_level_m, o.rainfall_mm) > 0
$$;

CREATE VIEW coverage_gate_sources AS
SELECT source_id
FROM source_priorities
WHERE active
  AND provides_observations
  AND universe_enumerable
  AND NOT historical_only;
