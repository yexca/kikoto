CREATE INDEX IF NOT EXISTS idx_metadata_snapshot_work_provider_latest
  ON metadata_snapshot(work_id, provider_id, fetched_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_metadata_snapshot_provider_external_latest
  ON metadata_snapshot(provider_id, external_id, fetched_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_party_metadata_snapshot_party_provider_latest
  ON party_metadata_snapshot(party_id, provider_id, fetched_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_work_primary_code_upper
  ON work(UPPER(primary_code));

CREATE INDEX IF NOT EXISTS idx_work_edition_primary_code_upper
  ON work_edition(UPPER(primary_code), logical_work_id);

CREATE INDEX IF NOT EXISTS idx_party_series_work_code_upper
  ON party_series_work(UPPER(primary_code), series_id);

CREATE INDEX IF NOT EXISTS idx_user_media_progress_user_latest
  ON user_media_progress(user_id, last_played_at DESC, updated_at DESC, media_item_id);
