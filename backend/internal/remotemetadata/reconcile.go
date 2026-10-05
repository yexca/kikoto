package remotemetadata

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"sort"
	"strings"

	"github.com/yexca/kikoto/backend/internal/metadatatags"
)

// Fields recorded in work_metadata_field_source.
const (
	FieldTitle       = "title"
	FieldReleaseDate = "release_date"
	FieldAgeRating   = "age_rating"
	FieldDuration    = "duration"
	FieldCircle      = "circle"
	FieldTags        = "tags"
	FieldCover       = "cover"
)

// Result describes what the reconciler found for one work.
type Result struct {
	// HigherPriority is true when DLsite (or another non-remote provider)
	// describes the work; remote values then only fill empty fields.
	HigherPriority bool
	Settings       Settings
	// TagProviderID is the first active fallback source whose snapshot
	// declares tags, or zero when remote tags must not enter shared tags.
	TagProviderID int64
	Tags          []metadatatags.ProviderTag
}

type snapshotInput struct {
	providerID int64
	rank       int
	active     bool
	work       Work
}

// ReconcileWorkTx derives a work's normalized fields from its stored remote
// snapshots in configured source order and records which source supplied each
// field. It is idempotent, makes no requests, and never creates a work.
func ReconcileWorkTx(ctx context.Context, tx *sql.Tx, workID int64) (Result, error) {
	settings, err := LoadSettings(ctx, tx)
	if err != nil {
		return Result{}, err
	}
	sources, err := LoadSources(ctx, tx, settings)
	if err != nil {
		return Result{}, err
	}
	inputs, err := loadSnapshotInputs(ctx, tx, workID, settings, sources)
	if err != nil {
		return Result{}, err
	}
	higher, err := hasHigherPriorityMetadata(ctx, tx, workID)
	if err != nil {
		return Result{}, err
	}
	result := Result{HigherPriority: higher, Settings: settings}
	if err := applyFields(ctx, tx, workID, inputs, higher); err != nil {
		return Result{}, err
	}
	if higher {
		return result, ClearTx(ctx, tx, workID)
	}
	if err := applyCircle(ctx, tx, workID, inputs, settings); err != nil {
		return Result{}, err
	}
	if settings.Enabled {
		for _, input := range inputs {
			if input.active && input.work.TagsDeclared {
				result.TagProviderID, result.Tags = input.providerID, input.work.Tags
				break
			}
		}
	}
	return result, nil
}

// ClearTx removes every remote provenance row of a work. DLsite metadata or
// the absence of remote snapshots makes them obsolete.
func ClearTx(ctx context.Context, tx *sql.Tx, workID int64) error {
	_, err := tx.ExecContext(ctx, "DELETE FROM work_metadata_field_source WHERE work_id = ?", workID)
	return err
}

// RecordFieldTx records or clears the source of one remote-filled field.
func RecordFieldTx(ctx context.Context, tx *sql.Tx, workID int64, field string, providerID int64) error {
	if providerID <= 0 {
		_, err := tx.ExecContext(ctx, "DELETE FROM work_metadata_field_source WHERE work_id = ? AND field_name = ?", workID, field)
		return err
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO work_metadata_field_source (work_id, field_name, provider_id) VALUES (?, ?, ?)
		ON CONFLICT(work_id, field_name) DO UPDATE SET provider_id = excluded.provider_id, updated_at = CURRENT_TIMESTAMP
		WHERE work_metadata_field_source.provider_id <> excluded.provider_id`, workID, field, providerID)
	return err
}

func loadSnapshotInputs(ctx context.Context, tx *sql.Tx, workID int64, settings Settings, sources []Source) ([]snapshotInput, error) {
	byProvider := map[string]Source{}
	for _, source := range sources {
		byProvider[source.ProviderCode] = source
	}
	rows, err := tx.QueryContext(ctx, `SELECT provider.id, provider.code, snapshot.snapshot_json
		FROM metadata_snapshot AS snapshot
		JOIN metadata_provider AS provider ON provider.id = snapshot.provider_id
		WHERE snapshot.work_id = ? AND provider.code GLOB 'kikoeru_source_*'
		ORDER BY provider.id, snapshot.fetched_at DESC, snapshot.id DESC`, workID)
	if err != nil {
		return nil, err
	}
	type stored struct {
		providerID int64
		code, raw  string
	}
	latest := []stored{}
	for rows.Next() {
		var item stored
		if err := rows.Scan(&item.providerID, &item.code, &item.raw); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if len(latest) == 0 || latest[len(latest)-1].providerID != item.providerID {
			latest = append(latest, item)
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	inputs := []snapshotInput{}
	for _, item := range latest {
		work, err := Decode([]byte(item.raw))
		if err != nil {
			slog.Warn("skipping remote metadata snapshot", "work_id", workID, "provider_id", item.providerID, "reason", err)
			continue
		}
		input := snapshotInput{providerID: item.providerID, rank: len(sources), work: work}
		if source, known := byProvider[item.code]; known {
			input.rank = source.Rank
			input.active = source.Active(settings)
		}
		inputs = append(inputs, input)
	}
	// Removed sources keep their snapshots for provenance and rank last.
	sort.SliceStable(inputs, func(left, right int) bool {
		if inputs[left].rank != inputs[right].rank {
			return inputs[left].rank < inputs[right].rank
		}
		return inputs[left].providerID < inputs[right].providerID
	})
	return inputs, nil
}

func hasHigherPriorityMetadata(ctx context.Context, tx *sql.Tx, workID int64) (bool, error) {
	var higher bool
	err := tx.QueryRowContext(ctx, `SELECT EXISTS (
			SELECT 1 FROM metadata_snapshot AS snapshot
			JOIN metadata_provider AS provider ON provider.id = snapshot.provider_id
			WHERE snapshot.work_id = ? AND provider.code NOT GLOB 'kikoeru_source_*'
			UNION ALL
			SELECT 1 FROM work_edition AS edition
			JOIN metadata_provider AS provider ON provider.id = edition.provider_id
			WHERE edition.work_id = ? AND provider.code = 'dlsite'
		)`, workID, workID).Scan(&higher)
	return higher, err
}

func firstInput(inputs []snapshotInput, has func(Work) bool) (snapshotInput, bool) {
	for _, input := range inputs {
		if has(input.work) {
			return input, true
		}
	}
	return snapshotInput{}, false
}

func applyFields(ctx context.Context, tx *sql.Tx, workID int64, inputs []snapshotInput, higher bool) error {
	var code, title, age string
	var release sql.NullString
	var duration sql.NullInt64
	if err := tx.QueryRowContext(ctx, "SELECT primary_code, title, release_date, age_rating, duration_seconds FROM work WHERE id = ?", workID).
		Scan(&code, &title, &release, &age, &duration); err != nil {
		return err
	}
	next := struct {
		title, age string
		release    sql.NullString
		duration   sql.NullInt64
	}{title, age, release, duration}
	sources := map[string]int64{}
	if winner, ok := firstInput(inputs, func(work Work) bool { return work.Title != "" }); ok {
		if !higher || strings.TrimSpace(title) == "" || strings.EqualFold(strings.TrimSpace(title), strings.TrimSpace(code)) {
			next.title = winner.work.Title
		}
		if next.title == winner.work.Title {
			sources[FieldTitle] = winner.providerID
		}
	}
	if winner, ok := firstInput(inputs, func(work Work) bool { return work.Release != "" }); ok {
		if !higher || !release.Valid {
			next.release = sql.NullString{String: winner.work.Release, Valid: true}
		}
		if next.release.String == winner.work.Release {
			sources[FieldReleaseDate] = winner.providerID
		}
	}
	if winner, ok := firstInput(inputs, func(work Work) bool { return work.AgeRating != "" }); ok {
		if !higher || strings.TrimSpace(age) == "" {
			next.age = winner.work.AgeRating
		}
		if next.age == winner.work.AgeRating {
			sources[FieldAgeRating] = winner.providerID
		}
	}
	if winner, ok := firstInput(inputs, func(work Work) bool { return work.Duration > 0 }); ok {
		if !higher || !duration.Valid {
			next.duration = sql.NullInt64{Int64: winner.work.Duration, Valid: true}
		}
		if next.duration.Int64 == winner.work.Duration {
			sources[FieldDuration] = winner.providerID
		}
	}
	if next.title != title || next.age != age || next.release != release || next.duration != duration {
		if _, err := tx.ExecContext(ctx, `UPDATE work SET title = ?, release_date = ?, age_rating = ?, duration_seconds = ?, updated_at = CURRENT_TIMESTAMP
			WHERE id = ?`, next.title, next.release, next.age, next.duration, workID); err != nil {
			return err
		}
	}
	if higher {
		return nil
	}
	for _, field := range []string{FieldTitle, FieldReleaseDate, FieldAgeRating, FieldDuration} {
		if err := RecordFieldTx(ctx, tx, workID, field, sources[field]); err != nil {
			return err
		}
	}
	return nil
}

// applyCircle keeps at most one remote circle relation, from the first source
// that names a circle. An existing circle matches by name or confirmed alias;
// only an active fallback source may create a new circle without a maker id.
func applyCircle(ctx context.Context, tx *sql.Tx, workID int64, inputs []snapshotInput, settings Settings) error {
	var authoritative, manual bool
	if err := tx.QueryRowContext(ctx, `SELECT
			EXISTS (SELECT 1 FROM work_party WHERE work_id = ? AND role IN ('circle', 'translator_circle', 'official_translation_brand')
				AND source NOT IN ('remote_source', 'circle_refresh', 'remote_source_catalog')
				UNION ALL SELECT 1 FROM work_edition WHERE work_id = ? AND maker_id <> ''),
			EXISTS (SELECT 1 FROM work_manual_override WHERE work_id = ? AND field_name = 'circle'
				UNION ALL SELECT 1 FROM work_party WHERE work_id = ? AND role = 'circle' AND source = 'manual_override')`,
		workID, workID, workID, workID).Scan(&authoritative, &manual); err != nil {
		return err
	}
	if authoritative || manual {
		return nil
	}
	partyID, providerID := int64(0), int64(0)
	if winner, ok := firstInput(inputs, func(work Work) bool { return work.Circle != "" }); ok {
		name := winner.work.Circle
		err := tx.QueryRowContext(ctx, `SELECT id FROM party
			WHERE party_type IN ('circle', 'brand', 'maker')
				AND (LOWER(display_name) = LOWER(?) OR EXISTS (SELECT 1 FROM party_alias WHERE party_id = party.id AND LOWER(alias) = LOWER(?)))
			ORDER BY id ASC LIMIT 1`, name, name).Scan(&partyID)
		if errors.Is(err, sql.ErrNoRows) && winner.active && settings.Enabled {
			result, insertErr := tx.ExecContext(ctx, `INSERT INTO party (party_type, display_name, sort_name, provider_name) VALUES ('circle', ?, ?, ?)`,
				name, strings.ToLower(name), name)
			if insertErr != nil {
				return insertErr
			}
			partyID, err = result.LastInsertId()
		}
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if partyID > 0 {
			providerID = winner.providerID
		}
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM work_party WHERE work_id = ? AND role = 'circle' AND source = 'remote_source' AND party_id <> ?", workID, partyID); err != nil {
		return err
	}
	if partyID > 0 {
		if _, err := tx.ExecContext(ctx, `INSERT INTO work_party (work_id, party_id, role, provider_id, source, updated_at)
			VALUES (?, ?, 'circle', ?, 'remote_source', CURRENT_TIMESTAMP)
			ON CONFLICT(work_id, party_id, role) DO UPDATE SET provider_id = excluded.provider_id, source = excluded.source, updated_at = CURRENT_TIMESTAMP
			WHERE work_party.provider_id IS NOT excluded.provider_id OR work_party.source <> excluded.source`, workID, partyID, providerID); err != nil {
			return err
		}
	}
	return RecordFieldTx(ctx, tx, workID, FieldCircle, providerID)
}
