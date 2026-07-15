ALTER TABLE file_source_endpoint
  ADD COLUMN work_url_template TEXT NOT NULL DEFAULT '/work/{code}';
