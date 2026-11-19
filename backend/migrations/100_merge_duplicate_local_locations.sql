-- A local path of a work is recorded once, on one media item. Where a work has
-- several local locations for one file source and path, the path keeps one
-- location, the available one checked last, on the oldest item that held it.
-- An item left with no location and no child is merged into that item and
-- removed: its per-user state, lyrics, transcriptions, and file names move to
-- it, the most recent entry winning where several have one. The item that
-- remains takes the removed item's local fingerprint and its scanned details
-- when its own fingerprint is not a local one, as a scan of the path records.

CREATE TEMP TABLE local_path_location AS
SELECT location.id AS location_id, location.media_item_id AS item_id,
	item.work_id, location.file_source_id, location.path
FROM media_file_location AS location
INNER JOIN media_item AS item ON item.id = location.media_item_id
WHERE location.location_type = 'local'
	AND EXISTS (
		SELECT 1 FROM media_file_location AS other
		INNER JOIN media_item AS other_item ON other_item.id = other.media_item_id
		WHERE other.location_type = 'local' AND other.file_source_id = location.file_source_id
			AND other.path = location.path AND other_item.work_id = item.work_id
			AND other.id <> location.id
	);

CREATE TEMP TABLE local_path_group AS
SELECT grouped.work_id, grouped.file_source_id, grouped.path,
	MIN(grouped.item_id) AS keeper_item_id,
	(
		SELECT candidate.location_id
		FROM local_path_location AS candidate
		INNER JOIN media_file_location AS location ON location.id = candidate.location_id
		WHERE candidate.work_id = grouped.work_id AND candidate.file_source_id = grouped.file_source_id
			AND candidate.path = grouped.path
		ORDER BY location.availability = 'available' DESC, COALESCE(location.last_checked_at, '') DESC, location.id DESC
		LIMIT 1
	) AS kept_location_id
FROM local_path_location AS grouped
GROUP BY grouped.work_id, grouped.file_source_id, grouped.path;

CREATE TEMP TABLE local_location_removal AS
SELECT location.location_id, path_group.kept_location_id
FROM local_path_location AS location
INNER JOIN local_path_group AS path_group
	ON path_group.work_id = location.work_id AND path_group.file_source_id = location.file_source_id
	AND path_group.path = location.path
WHERE location.location_id <> path_group.kept_location_id;

UPDATE media_file_location
SET media_item_id = (SELECT keeper_item_id FROM local_path_group WHERE kept_location_id = media_file_location.id)
WHERE id IN (SELECT kept_location_id FROM local_path_group);

UPDATE user_work_playback_cursor
SET location_id = (SELECT kept_location_id FROM local_location_removal WHERE location_id = user_work_playback_cursor.location_id)
WHERE location_id IN (SELECT location_id FROM local_location_removal);

UPDATE asr_transcription
SET audio_location_id = (SELECT kept_location_id FROM local_location_removal WHERE location_id = asr_transcription.audio_location_id)
WHERE audio_location_id IN (SELECT location_id FROM local_location_removal);

UPDATE llm_lyrics_asset
SET source_location_id = (SELECT kept_location_id FROM local_location_removal WHERE location_id = llm_lyrics_asset.source_location_id)
WHERE source_location_id IN (SELECT location_id FROM local_location_removal);

DELETE FROM media_file_location WHERE id IN (SELECT location_id FROM local_location_removal);

-- A reference to a kept location names the item that location belongs to.
UPDATE user_work_playback_cursor
SET media_item_id = (SELECT media_item_id FROM media_file_location WHERE id = user_work_playback_cursor.location_id)
WHERE location_id IN (SELECT kept_location_id FROM local_path_group);

UPDATE asr_transcription
SET audio_media_item_id = (SELECT media_item_id FROM media_file_location WHERE id = asr_transcription.audio_location_id)
WHERE audio_location_id IN (SELECT kept_location_id FROM local_path_group);

UPDATE llm_lyrics_asset
SET audio_media_item_id = (SELECT media_item_id FROM media_file_location WHERE id = llm_lyrics_asset.source_location_id)
WHERE source_location_id IN (SELECT kept_location_id FROM local_path_group);

CREATE TEMP TABLE local_item_merge AS
SELECT location.item_id AS loser_id, MIN(path_group.keeper_item_id) AS keeper_id
FROM local_path_location AS location
INNER JOIN local_path_group AS path_group
	ON path_group.work_id = location.work_id AND path_group.file_source_id = location.file_source_id
	AND path_group.path = location.path
WHERE location.item_id <> path_group.keeper_item_id
	AND NOT EXISTS (SELECT 1 FROM media_file_location WHERE media_item_id = location.item_id)
	AND NOT EXISTS (SELECT 1 FROM media_item WHERE parent_id = location.item_id)
GROUP BY location.item_id;

-- Every merged item and its keeper map to the keeper. For each key, the rows
-- of the keeper and all of its merged items are ranked together and only the
-- first is kept: the most recent entry, the keeper's own on a tie.
CREATE TEMP TABLE local_item_target AS
SELECT loser_id AS item_id, keeper_id AS target_id FROM local_item_merge
UNION
SELECT keeper_id, keeper_id FROM local_item_merge;

WITH ranked AS (
	SELECT progress.user_id, progress.media_item_id,
		ROW_NUMBER() OVER (
			PARTITION BY progress.user_id, target.target_id
			ORDER BY COALESCE(progress.last_played_at, progress.updated_at) DESC,
				progress.media_item_id = target.target_id DESC, progress.media_item_id
		) AS position
	FROM user_media_progress AS progress
	INNER JOIN local_item_target AS target ON target.item_id = progress.media_item_id
)
DELETE FROM user_media_progress
WHERE (user_id, media_item_id) IN (SELECT user_id, media_item_id FROM ranked WHERE position > 1);
UPDATE user_media_progress
SET media_item_id = (SELECT target_id FROM local_item_target WHERE item_id = user_media_progress.media_item_id)
WHERE media_item_id IN (SELECT loser_id FROM local_item_merge);

WITH ranked AS (
	SELECT lyrics_offset.user_id, lyrics_offset.audio_media_item_id,
		ROW_NUMBER() OVER (
			PARTITION BY lyrics_offset.user_id, target.target_id
			ORDER BY lyrics_offset.updated_at DESC, lyrics_offset.audio_media_item_id = target.target_id DESC, lyrics_offset.audio_media_item_id
		) AS position
	FROM user_media_lyrics_offset AS lyrics_offset
	INNER JOIN local_item_target AS target ON target.item_id = lyrics_offset.audio_media_item_id
)
DELETE FROM user_media_lyrics_offset
WHERE (user_id, audio_media_item_id) IN (SELECT user_id, audio_media_item_id FROM ranked WHERE position > 1);
UPDATE user_media_lyrics_offset
SET audio_media_item_id = (SELECT target_id FROM local_item_target WHERE item_id = user_media_lyrics_offset.audio_media_item_id)
WHERE audio_media_item_id IN (SELECT loser_id FROM local_item_merge);

-- A lyrics choice whose audio and lyrics become one item names nothing.
DELETE FROM user_media_lyrics_preference
WHERE (audio_media_item_id IN (SELECT item_id FROM local_item_target)
		OR lyrics_media_item_id IN (SELECT item_id FROM local_item_target))
	AND COALESCE((SELECT target_id FROM local_item_target WHERE item_id = user_media_lyrics_preference.audio_media_item_id), audio_media_item_id)
		= COALESCE((SELECT target_id FROM local_item_target WHERE item_id = user_media_lyrics_preference.lyrics_media_item_id), lyrics_media_item_id);
WITH ranked AS (
	SELECT preference.user_id, preference.audio_media_item_id,
		ROW_NUMBER() OVER (
			PARTITION BY preference.user_id, target.target_id
			ORDER BY preference.updated_at DESC, preference.audio_media_item_id = target.target_id DESC, preference.audio_media_item_id
		) AS position
	FROM user_media_lyrics_preference AS preference
	INNER JOIN local_item_target AS target ON target.item_id = preference.audio_media_item_id
)
DELETE FROM user_media_lyrics_preference
WHERE (user_id, audio_media_item_id) IN (SELECT user_id, audio_media_item_id FROM ranked WHERE position > 1);
UPDATE user_media_lyrics_preference
SET audio_media_item_id = COALESCE((SELECT target_id FROM local_item_target WHERE item_id = user_media_lyrics_preference.audio_media_item_id), audio_media_item_id),
	lyrics_media_item_id = COALESCE((SELECT target_id FROM local_item_target WHERE item_id = user_media_lyrics_preference.lyrics_media_item_id), lyrics_media_item_id)
WHERE audio_media_item_id IN (SELECT loser_id FROM local_item_merge)
	OR lyrics_media_item_id IN (SELECT loser_id FROM local_item_merge);

DELETE FROM media_lyrics_assignment
WHERE (audio_media_item_id IN (SELECT item_id FROM local_item_target)
		OR lyrics_media_item_id IN (SELECT item_id FROM local_item_target))
	AND COALESCE((SELECT target_id FROM local_item_target WHERE item_id = media_lyrics_assignment.audio_media_item_id), audio_media_item_id)
		= COALESCE((SELECT target_id FROM local_item_target WHERE item_id = media_lyrics_assignment.lyrics_media_item_id), lyrics_media_item_id);
WITH ranked AS (
	SELECT assignment.audio_media_item_id, assignment.language,
		ROW_NUMBER() OVER (
			PARTITION BY target.target_id, assignment.language
			ORDER BY assignment.updated_at DESC, assignment.audio_media_item_id = target.target_id DESC, assignment.audio_media_item_id
		) AS position
	FROM media_lyrics_assignment AS assignment
	INNER JOIN local_item_target AS target ON target.item_id = assignment.audio_media_item_id
)
DELETE FROM media_lyrics_assignment
WHERE (audio_media_item_id, language) IN (SELECT audio_media_item_id, language FROM ranked WHERE position > 1);
UPDATE media_lyrics_assignment
SET audio_media_item_id = COALESCE((SELECT target_id FROM local_item_target WHERE item_id = media_lyrics_assignment.audio_media_item_id), audio_media_item_id),
	lyrics_media_item_id = COALESCE((SELECT target_id FROM local_item_target WHERE item_id = media_lyrics_assignment.lyrics_media_item_id), lyrics_media_item_id)
WHERE audio_media_item_id IN (SELECT loser_id FROM local_item_merge)
	OR lyrics_media_item_id IN (SELECT loser_id FROM local_item_merge);

WITH ranked AS (
	SELECT display_name.media_item_id, display_name.language,
		ROW_NUMBER() OVER (
			PARTITION BY target.target_id, display_name.language
			ORDER BY display_name.updated_at DESC, display_name.media_item_id = target.target_id DESC, display_name.media_item_id
		) AS position
	FROM media_item_display_name AS display_name
	INNER JOIN local_item_target AS target ON target.item_id = display_name.media_item_id
)
DELETE FROM media_item_display_name
WHERE (media_item_id, language) IN (SELECT media_item_id, language FROM ranked WHERE position > 1);
UPDATE media_item_display_name
SET media_item_id = (SELECT target_id FROM local_item_target WHERE item_id = media_item_display_name.media_item_id)
WHERE media_item_id IN (SELECT loser_id FROM local_item_merge);

WITH ranked AS (
	SELECT source.lyrics_media_item_id,
		ROW_NUMBER() OVER (
			PARTITION BY target.target_id
			ORDER BY source.lyrics_media_item_id = target.target_id DESC, source.lyrics_media_item_id
		) AS position
	FROM media_lyrics_ai_source AS source
	INNER JOIN local_item_target AS target ON target.item_id = source.lyrics_media_item_id
)
DELETE FROM media_lyrics_ai_source
WHERE lyrics_media_item_id IN (SELECT lyrics_media_item_id FROM ranked WHERE position > 1);
UPDATE media_lyrics_ai_source
SET lyrics_media_item_id = (SELECT target_id FROM local_item_target WHERE item_id = media_lyrics_ai_source.lyrics_media_item_id)
WHERE lyrics_media_item_id IN (SELECT loser_id FROM local_item_merge);

-- References without a per-item key move as they are.
UPDATE user_work_playback_cursor
SET media_item_id = (SELECT keeper_id FROM local_item_merge WHERE loser_id = user_work_playback_cursor.media_item_id)
WHERE media_item_id IN (SELECT loser_id FROM local_item_merge);

UPDATE asr_transcription
SET audio_media_item_id = (SELECT keeper_id FROM local_item_merge WHERE loser_id = asr_transcription.audio_media_item_id)
WHERE audio_media_item_id IN (SELECT loser_id FROM local_item_merge);
UPDATE asr_transcription
SET lyrics_media_item_id = (SELECT keeper_id FROM local_item_merge WHERE loser_id = asr_transcription.lyrics_media_item_id)
WHERE lyrics_media_item_id IN (SELECT loser_id FROM local_item_merge);

UPDATE llm_lyrics_asset
SET audio_media_item_id = (SELECT keeper_id FROM local_item_merge WHERE loser_id = llm_lyrics_asset.audio_media_item_id)
WHERE audio_media_item_id IN (SELECT loser_id FROM local_item_merge);
UPDATE llm_lyrics_asset
SET media_item_id = (SELECT keeper_id FROM local_item_merge WHERE loser_id = llm_lyrics_asset.media_item_id)
WHERE media_item_id IN (SELECT loser_id FROM local_item_merge);

-- The remaining item becomes the scanned local item of its path.
CREATE TEMP TABLE local_item_identity AS
SELECT merged.keeper_id, loser.fingerprint, loser.kind, loser.title, loser.track_no,
	loser.duration_seconds, loser.has_audio, loser.size_bytes, loser.file_version
FROM local_item_merge AS merged
INNER JOIN media_item AS loser ON loser.id = merged.loser_id
INNER JOIN media_item AS keeper ON keeper.id = merged.keeper_id
WHERE substr(loser.fingerprint, 1, 6) = 'local:' AND substr(keeper.fingerprint, 1, 6) <> 'local:'
	AND merged.loser_id = (
		SELECT MIN(other.loser_id) FROM local_item_merge AS other
		INNER JOIN media_item AS other_item ON other_item.id = other.loser_id
		WHERE other.keeper_id = merged.keeper_id AND substr(other_item.fingerprint, 1, 6) = 'local:'
	);

DELETE FROM media_item WHERE id IN (SELECT loser_id FROM local_item_merge);

UPDATE media_item
SET fingerprint = identity.fingerprint, kind = identity.kind, title = identity.title,
	track_no = identity.track_no, duration_seconds = COALESCE(identity.duration_seconds, media_item.duration_seconds),
	has_audio = COALESCE(identity.has_audio, media_item.has_audio), size_bytes = COALESCE(identity.size_bytes, media_item.size_bytes),
	file_version = identity.file_version, parent_id = NULL
FROM local_item_identity AS identity
WHERE identity.keeper_id = media_item.id;

DROP TABLE local_item_identity;
DROP TABLE local_item_target;
DROP TABLE local_item_merge;
DROP TABLE local_location_removal;
DROP TABLE local_path_group;
DROP TABLE local_path_location;
