package circleidentity

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
)

// The table inventory is fixed application code. Snapshot JSON is never
// interpolated into SQL identifiers.
type tableSpec struct{ name, columns, keys, scope string }

var tables = []tableSpec{
	{"party", "id,party_type,display_name,sort_name,created_at,updated_at,manual_name,provider_name", "id", "id"},
	{"party_alias", "id,party_id,alias,source,created_at", "id", "party_id"},
	{"party_external_id", "id,party_id,provider_id,id_type,external_id,url,is_primary", "id", "party_id"},
	{"party_series", "id,party_id,provider_id,title_id,name,url,declared_works,raw_json,last_seen_at", "id", "party_id"},
	{"party_series_work", "series_id,primary_code,position,created_at,updated_at", "series_id,primary_code", "series_id IN (SELECT id FROM party_series WHERE party_id"},
	{"work_party", "work_id,party_id,role,provider_id,source,created_at,updated_at", "work_id,party_id,role", "party_id"},
	{"party_catalog_item", "id,party_id,provider_id,primary_code,title,release_date,url,catalog_status,dlsite_available,raw_json,last_seen_at", "id", "party_id"},
	{"party_metadata_snapshot", "id,party_id,provider_id,external_id,snapshot_json,fetched_at", "id", "party_id"},
	{"user_party_state", "user_id,party_id,rating,note,favorite,last_viewed_at,created_at,updated_at", "user_id,party_id", "party_id"},
	{"user_party_tag_assignment", "user_id,party_id,user_party_tag_id,created_at", "user_id,party_id,user_party_tag_id", "party_id"},
	{"party_merge_review", "id,target_party_id,source_party_id,target_name,source_name,snapshot_json,status,undone_at,created_at", "id", "target_party_id"},
	{"party_catalog_refresh_state", "party_id,provider_code,last_success_at,last_attempt_at,last_mode,last_status,last_run_id,last_error,updated_at", "party_id,provider_code", "party_id"},
}

type snapshot map[string][][]any
type mergeSnapshot struct {
	Before snapshot `json:"before"`
	After  snapshot `json:"after"`
}

func capture(ctx context.Context, tx *sql.Tx, target, source int64) (snapshot, error) {
	result := snapshot{}
	for _, spec := range tables {
		where := spec.scope + " IN (?,?)"
		if strings.HasPrefix(spec.scope, "series_id IN") {
			where += ")"
		}
		rows, err := tx.QueryContext(ctx, "SELECT "+spec.columns+" FROM "+spec.name+" WHERE "+where, target, source)
		if err != nil {
			return nil, err
		}
		data := [][]any{}
		for rows.Next() {
			values := make([]any, len(strings.Split(spec.columns, ",")))
			pointers := make([]any, len(values))
			for i := range values {
				pointers[i] = &values[i]
			}
			if err := rows.Scan(pointers...); err != nil {
				_ = rows.Close()
				return nil, err
			}
			data = append(data, values)
		}
		if err := closeRows(rows); err != nil {
			return nil, err
		}
		result[spec.name] = data
	}
	return result, nil
}
func key(spec tableSpec, row []any) string {
	columns := strings.Split(spec.columns, ",")
	keyValues := []any{}
	for _, key := range strings.Split(spec.keys, ",") {
		for i, column := range columns {
			if column == key {
				keyValues = append(keyValues, row[i])
			}
		}
	}
	raw, _ := json.Marshal(keyValues)
	return string(raw)
}
func rowMap(spec tableSpec, data [][]any) (map[string][]any, error) {
	result := map[string][]any{}
	for _, row := range data {
		if len(row) != len(strings.Split(spec.columns, ",")) {
			return nil, ErrConflict
		}
		result[key(spec, row)] = row
	}
	return result, nil
}
func equalRows(a, b []any) bool {
	// Preserve every captured metadata and personal-state value. A concurrent
	// edit to a merged value prevents destructive Undo.
	return reflect.DeepEqual(normalize(a), normalize(b))
}
func normalize(values []any) []string {
	result := make([]string, len(values))
	for i, value := range values {
		switch v := value.(type) {
		case []byte:
			result[i] = string(v)
		default:
			result[i] = fmt.Sprint(value)
		}
	}
	return result
}
func restore(ctx context.Context, tx *sql.Tx, record mergeSnapshot, current snapshot) error {
	// Validate all differences before applying one. New, unrelated rows are not
	// part of the captured diff and remain intact.
	for _, spec := range tables {
		before, err := rowMap(spec, record.Before[spec.name])
		if err != nil {
			return err
		}
		after, err := rowMap(spec, record.After[spec.name])
		if err != nil {
			return err
		}
		now, err := rowMap(spec, current[spec.name])
		if err != nil {
			return err
		}
		for k, row := range after {
			if equalRows(before[k], row) {
				continue
			}
			if !equalRows(now[k], row) {
				return ErrConflict
			}
		}
		for k := range before {
			if _, exists := after[k]; !exists {
				if _, exists := now[k]; exists {
					return ErrConflict
				}
			}
		}
	}
	for _, spec := range tables {
		before, _ := rowMap(spec, record.Before[spec.name])
		after, _ := rowMap(spec, record.After[spec.name])
		// Remove additions before restoring original rows with unique keys.
		for k, row := range after {
			if _, exists := before[k]; exists {
				continue
			}
			values := []any{}
			where := []string{}
			columns := strings.Split(spec.columns, ",")
			for _, pk := range strings.Split(spec.keys, ",") {
				for i, col := range columns {
					if col == pk {
						values = append(values, row[i])
						where = append(where, pk+"=?")
					}
				}
			}
			if _, err := tx.ExecContext(ctx, "DELETE FROM "+spec.name+" WHERE "+strings.Join(where, " AND "), values...); err != nil {
				return err
			}
		}
		columns := strings.Split(spec.columns, ",")
		updates := []string{}
		for _, col := range columns {
			updates = append(updates, col+"=excluded."+col)
		}
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(columns)), ",")
		query := "INSERT INTO " + spec.name + "(" + spec.columns + ") VALUES (" + placeholders + ") ON CONFLICT(" + spec.keys + ") DO UPDATE SET " + strings.Join(updates, ",")
		for k, row := range before {
			if equalRows(after[k], row) {
				continue
			}
			if _, err := tx.ExecContext(ctx, query, row...); err != nil {
				return err
			}
		}
	}
	return nil
}
