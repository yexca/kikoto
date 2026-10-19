-- The language spoken in a transcribed track, sent to the service as its
-- hint. It equals the lyrics language unless a translating model writes the
-- lyrics in another language from that speech.
ALTER TABLE asr_transcription ADD COLUMN audio_language TEXT NOT NULL DEFAULT ''
  CHECK(audio_language IN ('', 'ja-jp', 'zh-cn', 'zh-tw', 'en-us', 'ko-kr'));

UPDATE asr_transcription SET audio_language = language;
