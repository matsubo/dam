-- Cover image URL for each dam. Sourced from Damnet's wp-content/uploads
-- via bin/fetch_dam_images.ts; nullable since coverage is partial.
ALTER TABLE dams ADD COLUMN IF NOT EXISTS image_url TEXT;
