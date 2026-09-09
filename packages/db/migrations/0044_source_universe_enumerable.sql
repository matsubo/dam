-- Not every provider publishes a station list we can enumerate.
--
-- 鹿児島県防災 is the clear case: its portal lists dams only during a flood
-- event, so on an ordinary day it returns nothing. That leaves two bad
-- options if it counts toward the "has every provider been scanned?" gate:
-- stamp a scan on an empty list (a quiet day then closes the gate and every
-- 鹿児島 dam reads 提供元なし — a false negative), or never stamp one (the
-- gate never closes and NO dam anywhere can ever reach not_published, so the
-- feature never answers).
--
-- Neither is honest, so say the true thing instead: this provider's published
-- list cannot be enumerated. It is excluded from the gate, and the coverage
-- summary reports how many such providers exist so the caveat stays visible
-- rather than being silently assumed away.
ALTER TABLE source_priorities
  ADD COLUMN universe_enumerable BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN source_priorities.universe_enumerable IS
  'FALSE when the provider publishes no station list we can enumerate, so it is excluded from the source_universe scan gate.';

UPDATE source_priorities SET universe_enumerable = FALSE
  WHERE source_id = 'kagoshima-bousai';
