-- A record file's progress is ordered by when the client captured it, so a
-- save that arrives late never replaces a later position. Rows written before
-- the order existed carry 0 and give way to any ordered save.
ALTER TABLE record_asset_progress ADD COLUMN report_order INTEGER NOT NULL DEFAULT 0;
