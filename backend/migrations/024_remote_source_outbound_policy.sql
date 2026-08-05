ALTER TABLE file_source_endpoint
  ADD COLUMN restrict_outbound_hosts INTEGER NOT NULL DEFAULT 0 CHECK(restrict_outbound_hosts IN (0, 1));

ALTER TABLE file_source_endpoint
  ADD COLUMN allowed_host_patterns_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(allowed_host_patterns_json));
