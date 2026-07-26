ALTER TABLE media_item ADD COLUMN has_audio INTEGER;

UPDATE media_item
SET has_audio = 1
WHERE kind = 'audio';
