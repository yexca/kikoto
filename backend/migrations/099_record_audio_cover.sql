-- A record audio file may embed cover art, which becomes its thumbnail. Audio
-- files probed before the probe read cover art are probed again.

ALTER TABLE record_asset ADD COLUMN has_cover INTEGER;

UPDATE record_asset SET probe_state = 'pending' WHERE kind = 'audio' AND probe_state = 'ready';
