-- Older editors saved every displayed field, freezing a projected title as
-- an all-language override. Remove only exact, trimmed provider title matches.
-- Other fields and deliberately different titles remain authored data.
DELETE FROM work_manual_override
WHERE field_name = 'title'
  AND json_type(CASE WHEN json_valid(value_json) THEN value_json ELSE 'null' END) = 'text'
  AND EXISTS (
    SELECT 1 FROM dlsite_metadata_variant AS variant
    WHERE (
      variant.work_id = work_manual_override.work_id
      OR variant.logical_work_id IN (
        SELECT logical_work_id FROM work_edition
        WHERE work_id = work_manual_override.work_id
      )
    )
    AND TRIM(json_extract(CASE WHEN json_valid(work_manual_override.value_json) THEN work_manual_override.value_json ELSE 'null' END, '$'), char(9,10,11,12,13,32,133,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288)) =
        TRIM(variant.title, char(9,10,11,12,13,32,133,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288))
  );
