-- Unique index per source value within external_ids
CREATE UNIQUE INDEX dams_ext_ndi_uniq
  ON dams ((external_ids ->> 'ndi')) WHERE external_ids ? 'ndi';
CREATE UNIQUE INDEX dams_ext_damnet_uniq
  ON dams ((external_ids ->> 'damnet')) WHERE external_ids ? 'damnet';
