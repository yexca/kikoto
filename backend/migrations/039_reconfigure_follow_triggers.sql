-- The follow presets were reduced to input, filter, and actions. Track, Fetch,
-- the new-works switch, and the metadata refresh choice are no longer inputs,
-- so a stored follow trigger cannot be reinterpreted safely. Disable every
-- follow trigger and ask its owner to reconfigure it; the stored inputs stay so
-- the Workflows page can prefill what still applies.

UPDATE workflow_trigger
SET enabled = 0,
    next_run_at = NULL,
    last_error_message = 'Follow options changed. Reconfigure this trigger, then enable it again.',
    updated_at = CURRENT_TIMESTAMP
WHERE workflow_definition_id IN (
  SELECT id FROM workflow_definition WHERE code IN ('circle_follow', 'series_follow', 'voice_follow')
);
