UPDATE media_item
SET kind = 'video',
    has_audio = NULL
WHERE LOWER(fingerprint) LIKE '%.mp4'
   OR LOWER(fingerprint) LIKE '%.m4v'
   OR LOWER(fingerprint) LIKE '%.webm'
   OR LOWER(fingerprint) LIKE '%.mkv'
   OR LOWER(fingerprint) LIKE '%.mov'
   OR LOWER(fingerprint) LIKE '%.avi';
