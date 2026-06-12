-- 0031_add_nakazato_nagano.sql
--
-- 中里ダム (Nakazato Dam) — 長野県木曽郡, 木曽川水系.
-- Managed by 水資源機構 中部支社 (JWA Chubu).
-- Referenced as '中里ダム' in jwa-chubu and '中里貯水池' in jwa-kiso-rt.
-- Distinct from nakazato-24 (pref_code=24, Mie).
-- Coordinates are approximate (木曽川水系, 長野県木曽郡).

INSERT INTO dams (slug, name, pref_code, location)
VALUES (
  'nakazato-20',
  '中里',
  '20',
  ST_SetSRID(ST_MakePoint(137.60, 35.70), 4326)
)
ON CONFLICT (slug) DO NOTHING;
