package httpapi

import (
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/library"
)

// Demo applies the same legacy snapshot identity rule as card presentation
// before counting or taking a page. The static predicate belongs to app
// composition; production Library queries do not receive it.
var demoLibraryVisibilityPredicateSQL = `NOT EXISTS (
	SELECT 1 FROM work_edition AS demo_edition
	INNER JOIN logical_work AS demo_logical ON demo_logical.id=demo_edition.logical_work_id
	WHERE demo_edition.work_id=work.id AND demo_edition.is_canonical=0
		AND demo_logical.canonical_work_id IS NOT NULL AND demo_logical.canonical_work_id<>work.id
) AND NOT EXISTS (
	SELECT 1 FROM work AS demo_base_work
	WHERE demo_base_work.primary_code<>'' AND UPPER(demo_base_work.primary_code)=UPPER(` + demoSnapshotBaseCodeSQL("work.id") + `)
)`

// LatestSnapshotCardColumnsSQL selects exactly the summary/raw pair the card
// scanner reads. Its compact summary already stores the parsed base identity.
// Raw fallback follows parseDLsiteSnapshot: first nonempty base field, then
// normalized language-edition origin, with current-code identity suppressed.
func demoSnapshotBaseCodeSQL(workIDExpression string) string {
	baseFields := demoSnapshotFirstStringSQL("payload_json",
		"$.translation_info.original_workno", "$.translation_info.parent_workno",
		"$.original_workno", "$.original_work_number", "$.base_workno", "$.base_code")
	currentFields := demoSnapshotFirstStringSQL("payload_json", "$.workno", "$.product_id")
	identityTypes := demoSnapshotStringFieldsValidSQL("payload_json",
		"$.translation_info.original_workno", "$.translation_info.parent_workno", "$.translation_info.lang",
		"$.original_workno", "$.original_work_number", "$.base_workno", "$.base_code", "$.workno", "$.product_id")
	editionCode := "UPPER(" + demoSnapshotTrimSQL("json_extract(demo_edition.value,'$.workno')") + ")"
	return `(WITH demo_card AS MATERIALIZED (
		SELECT ` + library.LatestSnapshotCardColumnsSQL(workIDExpression, true) + `
	), demo_json AS MATERIALIZED (
		SELECT CASE WHEN json_valid(card_summary_json) THEN card_summary_json ELSE '{}' END AS summary_json,
			CASE WHEN json_valid(snapshot_json) THEN snapshot_json ELSE '{}' END AS raw_json
		FROM demo_card
	), demo_payload AS MATERIALIZED (
		SELECT summary_json, CASE
			WHEN json_type(raw_json,'$.product')='object' THEN json_extract(raw_json,'$.product')
			WHEN json_type(raw_json,'$.product') IS NOT NULL THEN '{}'
			WHEN json_type(raw_json)='object' THEN raw_json ELSE '{}' END AS payload_json
		FROM demo_json
	), demo_valid_payload AS MATERIALIZED (
		SELECT summary_json, CASE WHEN ` + identityTypes + `
			AND COALESCE(json_type(payload_json,'$.translation_info'),'null') IN ('object','null')
			AND COALESCE(json_type(payload_json,'$.language_editions'),'null') IN ('array','null')
			AND NOT EXISTS (SELECT 1 FROM json_each(payload_json,'$.language_editions') AS demo_edition
				WHERE demo_edition.type NOT IN ('object','null') OR CASE WHEN demo_edition.type='object' THEN
					NOT (` + demoSnapshotStringFieldsValidSQL("demo_edition.value", "$.workno", "$.label", "$.lang") + `
						AND COALESCE(json_type(demo_edition.value,'$.display_order'),'null') IN ('integer','null'))
					ELSE 0 END)
			THEN payload_json ELSE '{}' END AS payload_json
		FROM demo_payload
	), demo_raw_fields AS MATERIALIZED (
		SELECT summary_json, payload_json, UPPER(` + baseFields + `) AS raw_base_code,
			UPPER(` + currentFields + `) AS raw_current_code
		FROM demo_valid_payload
	), demo_codes AS MATERIALIZED (
		SELECT summary_json, ` + demoNormalizedSnapshotCodeSQL("raw_base_code") + ` AS base_code,
			` + demoNormalizedSnapshotCodeSQL("raw_current_code") + ` AS current_code,
			COALESCE((SELECT code FROM (
				SELECT ` + demoNormalizedSnapshotCodeSQL(editionCode) + ` AS code,
					CASE WHEN COALESCE(json_extract(demo_edition.value,'$.display_order'),0)>0
						THEN json_extract(demo_edition.value,'$.display_order') ELSE CAST(demo_edition.key AS INTEGER)+1 END AS edition_order,
					CAST(demo_edition.key AS INTEGER) AS edition_index
				FROM json_each(payload_json,'$.language_editions') AS demo_edition WHERE demo_edition.type='object'
			) WHERE code<>'' ORDER BY edition_order,edition_index LIMIT 1),'') AS origin_code
		FROM demo_raw_fields
	), demo_identity AS (
		SELECT summary_json,current_code,CASE WHEN base_code<>'' THEN base_code ELSE origin_code END AS base_code
		FROM demo_codes
	)
	SELECT CASE WHEN json_type(summary_json,'$.v')='integer' AND json_extract(summary_json,'$.v')=` + strconv.Itoa(library.SnapshotCardSummaryVersion) + `
		AND ` + demoSnapshotStringFieldsValidSQL("summary_json", "$.baseCode") + `
		THEN COALESCE(json_extract(summary_json,'$.baseCode'),'')
		WHEN base_code=current_code THEN '' ELSE base_code END
	FROM demo_identity)`
}

// strings.TrimSpace accepts Unicode White_Space, while SQLite's default TRIM
// only removes ASCII spaces. Keep code-field selection and normalization equal.
func demoSnapshotTrimSQL(expression string) string {
	return "TRIM(" + expression + ", '\t\n\v\f\r \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000')"
}

func demoSnapshotFirstStringSQL(expression string, paths ...string) string {
	values := make([]string, 0, len(paths)+1)
	for _, path := range paths {
		values = append(values, "NULLIF("+demoSnapshotTrimSQL("json_extract("+expression+",'"+path+"')")+",'')")
	}
	return "COALESCE(" + strings.Join(append(values, "''"), ",") + ")"
}

func demoSnapshotStringFieldsValidSQL(expression string, paths ...string) string {
	checks := make([]string, len(paths))
	for index, path := range paths {
		checks[index] = "COALESCE(json_type(" + expression + ",'" + path + "'),'null') IN ('text','null')"
	}
	return strings.Join(checks, " AND ")
}

func demoNormalizedSnapshotCodeSQL(expression string) string {
	return "CASE WHEN LENGTH(" + expression + ") BETWEEN 7 AND 10 AND SUBSTR(" + expression + ",1,2) IN ('RJ','BJ','VJ') AND SUBSTR(" + expression + ",3) NOT GLOB '*[^0-9]*' THEN " + expression + " ELSE '' END"
}
