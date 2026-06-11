-- Fix jwa-chiba-bouso observations where storage_rate was stored as percent (0-100)
-- instead of fraction (0-1). The adapter was missing the /100 conversion.
-- Only affects 長柄ダム and 東金ダム (pref 12, 利根川 watershed).
UPDATE observations
SET storage_rate = storage_rate / 100
WHERE source_id = 'jwa-chiba-bouso'
  AND storage_rate > 1;
