-- Bump default rate limits for newly issued API keys and re-baseline existing
-- keys still on the original 60/min · 10,000/day defaults. Anyone with a
-- custom limit (i.e. non-default value) keeps their setting.
ALTER TABLE api_keys ALTER COLUMN rate_per_min SET DEFAULT 600;
ALTER TABLE api_keys ALTER COLUMN rate_per_day SET DEFAULT 100000;

UPDATE api_keys SET rate_per_min = 600   WHERE rate_per_min = 60;
UPDATE api_keys SET rate_per_day = 100000 WHERE rate_per_day = 10000;
