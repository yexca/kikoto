package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
)

// Voice credits and DLsite circle relations are projected from each work's
// latest metadata snapshot. work_snapshot_projection records the snapshot and
// projection input each work last produced, so a pass reads only works whose
// latest snapshot changed since then, in bounded batches, instead of loading
// every snapshot of the library. A changed snapshot whose projection input is
// unchanged, such as a new sales count, only advances the record. Triggers
// drop a record when another writer removes or reassigns a projected row, so
// the next pass restores what the snapshot still declares.
const (
	snapshotProjectionVoiceCredits = "voice_credit"
	snapshotProjectionDLsiteParty  = "dlsite_party"
	// Increase snapshotProjectionVersion when a projection starts writing
	// different rows for the same snapshot, so every work is projected again.
	snapshotProjectionVersion = 1
	snapshotProjectionBatch   = 200
)

// projectChangedSnapshots projects the works whose latest snapshot changed
// since their last projection. Startup and metadata sync run it; an empty
// record table projects every work once.
func (s *Server) projectChangedSnapshots(ctx context.Context) error {
	if err := s.projectChangedDLsiteParties(ctx); err != nil {
		return err
	}
	return s.projectChangedVoiceCredits(ctx)
}

func snapshotProjectionHash(input any) (string, error) {
	encoded, err := json.Marshal(input)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}

func recordSnapshotProjection(ctx context.Context, execer contextExecer, workID int64, kind string, snapshotID int64, inputHash string) error {
	_, err := execer.ExecContext(ctx, `
		INSERT INTO work_snapshot_projection (work_id, kind, snapshot_id, version, input_hash)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(work_id, kind) DO UPDATE SET
			snapshot_id = excluded.snapshot_id,
			version = excluded.version,
			input_hash = excluded.input_hash
	`, workID, kind, snapshotID, snapshotProjectionVersion, inputHash)
	return err
}

// voiceCreditProjection is one work's latest snapshot from any provider.
type voiceCreditProjection struct {
	voiceCreditSnapshotRow
	SnapshotID   int64
	RecordedHash string
}

// voiceCreditProjectionSQL selects works whose latest snapshot has not been
// projected by this version. The caller appends the remaining filter.
const voiceCreditProjectionSQL = `
	SELECT work.id, snapshot.id, snapshot.provider_id, snapshot.snapshot_json, COALESCE(projection.input_hash, '')
	FROM work
	INNER JOIN metadata_snapshot AS snapshot ON snapshot.id = (
		SELECT latest.id
		FROM metadata_snapshot AS latest
		WHERE latest.work_id = work.id
		ORDER BY latest.fetched_at DESC, latest.id DESC
		LIMIT 1
	)
	LEFT JOIN work_snapshot_projection AS projection
		ON projection.work_id = work.id AND projection.kind = 'voice_credit'
	WHERE (
		projection.work_id IS NULL
		OR projection.snapshot_id <> snapshot.id
		OR projection.version <> ?
	)
`

func scanVoiceCreditProjections(rows *sql.Rows) ([]voiceCreditProjection, error) {
	defer func() { _ = rows.Close() }()
	projections := []voiceCreditProjection{}
	for rows.Next() {
		var projection voiceCreditProjection
		if err := rows.Scan(&projection.WorkID, &projection.SnapshotID, &projection.ProviderID, &projection.Raw, &projection.RecordedHash); err != nil {
			return nil, err
		}
		projections = append(projections, projection)
	}
	return projections, rows.Err()
}

func (s *Server) projectChangedVoiceCredits(ctx context.Context) error {
	var afterWorkID int64
	for {
		rows, err := s.db.QueryContext(ctx, voiceCreditProjectionSQL+`
			AND work.id > ?
			ORDER BY work.id
			LIMIT ?
		`, snapshotProjectionVersion, afterWorkID, snapshotProjectionBatch)
		if err != nil {
			return err
		}
		batch, err := scanVoiceCreditProjections(rows)
		if err != nil || len(batch) == 0 {
			return err
		}
		afterWorkID = batch[len(batch)-1].WorkID
		if err := s.applyVoiceCreditProjections(ctx, batch); err != nil {
			return err
		}
		if len(batch) < snapshotProjectionBatch {
			return nil
		}
	}
}

// syncVoiceCreditsForWorkFromSnapshots projects one work's voice credits after
// its metadata changed outside a full pass, such as a family sync.
func (s *Server) syncVoiceCreditsForWorkFromSnapshots(ctx context.Context, workID int64) error {
	rows, err := s.db.QueryContext(ctx, voiceCreditProjectionSQL+` AND work.id = ?`, snapshotProjectionVersion, workID)
	if err != nil {
		return err
	}
	batch, err := scanVoiceCreditProjections(rows)
	if err != nil || len(batch) == 0 {
		return err
	}
	return s.applyVoiceCreditProjections(ctx, batch)
}

func (s *Server) applyVoiceCreditProjections(ctx context.Context, batch []voiceCreditProjection) error {
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, projection := range batch {
		actors := voiceCreditActors(projection.Raw)
		hash, err := snapshotProjectionHash(struct {
			ProviderID sql.NullInt64
			Actors     []voiceActorIdentity
		}{projection.ProviderID, actors})
		if err != nil {
			return err
		}
		if hash != projection.RecordedHash {
			if err := writeVoiceCredits(ctx, tx, projection.WorkID, projection.ProviderID, actors); err != nil {
				return err
			}
		}
		if err := recordSnapshotProjection(ctx, tx, projection.WorkID, snapshotProjectionVoiceCredits, projection.SnapshotID, hash); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// dlsitePartyProjection is one work's latest DLsite snapshot.
type dlsitePartyProjection struct {
	dlsitePartySnapshotProjection
	SnapshotID   int64
	RecordedHash string
}

func (s *Server) projectChangedDLsiteParties(ctx context.Context) error {
	providerID, ok, err := s.dlsiteProviderID(ctx)
	if err != nil || !ok {
		return err
	}
	projected := []int64{}
	var afterWorkID int64
	for {
		batch, err := s.queryDLsitePartyProjections(ctx, providerID, `
			AND work.id > ?
			ORDER BY work.id
			LIMIT ?
		`, afterWorkID, snapshotProjectionBatch)
		if err != nil {
			return err
		}
		if len(batch) == 0 {
			break
		}
		afterWorkID = batch[len(batch)-1].WorkID
		changed, err := s.applyDLsitePartyProjections(ctx, batch)
		if err != nil {
			return err
		}
		projected = append(projected, changed...)
		if len(batch) < snapshotProjectionBatch {
			break
		}
	}
	return s.reconcileDLsiteCircleOwnership(ctx, projected)
}

// syncPartyForWorkFromSnapshot projects one work's circle after its metadata
// changed outside a full pass, such as a family sync.
func (s *Server) syncPartyForWorkFromSnapshot(ctx context.Context, code string) error {
	providerID, ok, err := s.dlsiteProviderID(ctx)
	if err != nil || !ok {
		return err
	}
	batch, err := s.queryDLsitePartyProjections(ctx, providerID, ` AND UPPER(work.primary_code) = UPPER(?)`, code)
	if err != nil {
		return err
	}
	_, err = s.applyDLsitePartyProjections(ctx, batch)
	return err
}

func (s *Server) dlsiteProviderID(ctx context.Context) (int64, bool, error) {
	var providerID int64
	err := s.db.QueryRowContext(ctx, "SELECT id FROM metadata_provider WHERE code = 'dlsite'").Scan(&providerID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	return providerID, err == nil, err
}

// queryDLsitePartyProjections selects works whose latest DLsite snapshot has
// not been projected by this version, narrowed by filter.
func (s *Server) queryDLsitePartyProjections(ctx context.Context, providerID int64, filter string, args ...any) ([]dlsitePartyProjection, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT work.id, snapshot.id, snapshot.provider_id, work.primary_code, work.title, work.release_date,
			snapshot.snapshot_json, COALESCE(projection.input_hash, '')
		FROM work
		INNER JOIN metadata_snapshot AS snapshot ON snapshot.id = (
			SELECT latest.id
			FROM metadata_snapshot AS latest
			WHERE latest.work_id = work.id AND latest.provider_id = ?
			ORDER BY latest.fetched_at DESC, latest.id DESC
			LIMIT 1
		)
		LEFT JOIN work_snapshot_projection AS projection
			ON projection.work_id = work.id AND projection.kind = 'dlsite_party'
		WHERE (
			projection.work_id IS NULL
			OR projection.snapshot_id <> snapshot.id
			OR projection.version <> ?
		)
	`+filter, append([]any{providerID, snapshotProjectionVersion}, args...)...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	batch := []dlsitePartyProjection{}
	for rows.Next() {
		var projection dlsitePartyProjection
		if err := rows.Scan(&projection.WorkID, &projection.SnapshotID, &projection.ProviderID, &projection.Code,
			&projection.Title, &projection.Release, &projection.Raw, &projection.RecordedHash); err != nil {
			return nil, err
		}
		batch = append(batch, projection)
	}
	return batch, rows.Err()
}

// applyDLsitePartyProjections writes each work's circle, catalog row, and
// circle relation when its projection input changed and the stored rows do
// not already match it. It returns the works whose input changed.
func (s *Server) applyDLsitePartyProjections(ctx context.Context, batch []dlsitePartyProjection) ([]int64, error) {
	if len(batch) == 0 {
		return nil, nil
	}
	changed := []int64{}
	hashes := make([]string, len(batch))
	for index, projection := range batch {
		party := parsePartyFromDLsiteSnapshot(projection.Raw)
		rawDigest := sha256.Sum256([]byte(projection.Raw))
		hash, err := snapshotProjectionHash(struct {
			Party   parsedParty
			Code    string
			Title   string
			Release sql.NullString
			URL     string
			Raw     string
		}{party, strings.ToUpper(strings.TrimSpace(projection.Code)), projection.Title, projection.Release, s.dlsiteURL(projection.Code), hex.EncodeToString(rawDigest[:])})
		if err != nil {
			return nil, err
		}
		hashes[index] = hash
		if hash == projection.RecordedHash {
			continue
		}
		changed = append(changed, projection.WorkID)
		if !dlsiteMakerIDPattern.MatchString(party.ExternalID) || party.DisplayName == "" {
			continue
		}
		current, err := s.dlsitePartyProjectionCurrent(ctx, projection.dlsitePartySnapshotProjection, party)
		if err != nil {
			return nil, err
		}
		if !current {
			if err := s.writeDLsitePartyProjection(ctx, projection.dlsitePartySnapshotProjection, party); err != nil {
				return nil, err
			}
		}
	}
	// Recorded after every write of the batch, because a relation write drops
	// the work's earlier record.
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	for index, projection := range batch {
		if err := recordSnapshotProjection(ctx, tx, projection.WorkID, snapshotProjectionDLsiteParty, projection.SnapshotID, hashes[index]); err != nil {
			return nil, err
		}
	}
	return changed, tx.Commit()
}
