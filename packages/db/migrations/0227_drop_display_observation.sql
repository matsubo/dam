-- display_observation() is replaced by dam_reading() (0226, docs/adr/0002).
-- 0226 kept it so the old web pods still serving during that rollout kept
-- working; nothing calls it once that release is live everywhere.
DROP FUNCTION IF EXISTS display_observation(BIGINT, BOOLEAN, INTERVAL);
