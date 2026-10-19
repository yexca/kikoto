package httpapi

import (
	"context"
	"database/sql"

	"github.com/yexca/kikoto/backend/internal/dlsite"
)

// Staff credits are a work's non-voice credits, such as its scenario writer
// and illustrator. They are projected from the work's latest DLsite snapshot
// into work_staff_credit, which the work detail and the search index read.
// Unlike voice credits they name no person entity: a staff name is a plain
// credit of the work, kept with DLsite's creator id.

// staffCreditSourceSnapshot marks rows the snapshot projection owns and
// replaces.
const staffCreditSourceSnapshot = "metadata_snapshot"

// staffCredit is one staff credit of a work detail.
type staffCredit struct {
	Role string `json:"role"`
	Name string `json:"name"`
}

// staffCreditProjection is one work's latest DLsite snapshot.
type staffCreditProjection struct {
	WorkID       int64
	SnapshotID   int64
	ProviderID   sql.NullInt64
	Raw          string
	RecordedHash string
}

func (s *Server) projectChangedStaffCredits(ctx context.Context) error {
	providerID, ok, err := s.dlsiteProviderID(ctx)
	if err != nil || !ok {
		return err
	}
	var afterWorkID int64
	for {
		batch, err := s.queryStaffCreditProjections(ctx, providerID, `
			AND work.id > ?
			ORDER BY work.id
			LIMIT ?
		`, afterWorkID, snapshotProjectionBatch)
		if err != nil || len(batch) == 0 {
			return err
		}
		afterWorkID = batch[len(batch)-1].WorkID
		if err := s.applyStaffCreditProjections(ctx, batch); err != nil {
			return err
		}
		if len(batch) < snapshotProjectionBatch {
			return nil
		}
	}
}

// queryStaffCreditProjections selects works whose latest DLsite snapshot has
// not been projected into staff credits by this version, narrowed by filter.
func (s *Server) queryStaffCreditProjections(ctx context.Context, providerID int64, filter string, args ...any) ([]staffCreditProjection, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT work.id, snapshot.id, snapshot.provider_id, snapshot.snapshot_json, COALESCE(projection.input_hash, '')
		FROM work
		INNER JOIN metadata_snapshot AS snapshot ON snapshot.id = (
			SELECT latest.id
			FROM metadata_snapshot AS latest
			WHERE latest.work_id = work.id AND latest.provider_id = ?
			ORDER BY latest.fetched_at DESC, latest.id DESC
			LIMIT 1
		)
		LEFT JOIN work_snapshot_projection AS projection
			ON projection.work_id = work.id AND projection.kind = 'staff_credit'
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
	batch := []staffCreditProjection{}
	for rows.Next() {
		var projection staffCreditProjection
		if err := rows.Scan(&projection.WorkID, &projection.SnapshotID, &projection.ProviderID, &projection.Raw, &projection.RecordedHash); err != nil {
			return nil, err
		}
		batch = append(batch, projection)
	}
	return batch, rows.Err()
}

func (s *Server) applyStaffCreditProjections(ctx context.Context, batch []staffCreditProjection) error {
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, projection := range batch {
		staff := parseDLsiteSnapshot(projection.Raw).Staff
		hash, err := snapshotProjectionHash(struct {
			ProviderID sql.NullInt64
			Staff      []dlsite.StaffCredit
		}{projection.ProviderID, staff})
		if err != nil {
			return err
		}
		if hash != projection.RecordedHash {
			if err := writeStaffCredits(ctx, tx, projection.WorkID, projection.ProviderID, staff); err != nil {
				return err
			}
		}
		if err := recordSnapshotProjection(ctx, tx, projection.WorkID, snapshotProjectionStaffCredits, projection.SnapshotID, hash); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// writeStaffCredits replaces the work's snapshot-owned staff credits with the
// snapshot's, so a credit the provider no longer names is removed.
func writeStaffCredits(ctx context.Context, tx *sql.Tx, workID int64, providerID sql.NullInt64, staff []dlsite.StaffCredit) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM work_staff_credit WHERE work_id = ? AND source = ?`, workID, staffCreditSourceSnapshot); err != nil {
		return err
	}
	var provider any
	if providerID.Valid {
		provider = providerID.Int64
	}
	for position, credit := range staff {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO work_staff_credit (work_id, role, position, name, provider_id, external_id, source)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(work_id, role, name) DO NOTHING
		`, workID, credit.Role, position, credit.Name, provider, string(credit.ID), staffCreditSourceSnapshot); err != nil {
			return err
		}
	}
	return nil
}

// loadWorkStaffCredits returns a work's staff credits in role order and then
// credit order.
func (s *Server) loadWorkStaffCredits(ctx context.Context, workID int64) ([]staffCredit, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT role, name
		FROM work_staff_credit
		WHERE work_id = ?
		ORDER BY CASE role
			WHEN 'author' THEN 0
			WHEN 'scenario' THEN 1
			WHEN 'illustration' THEN 2
			WHEN 'music' THEN 3
			ELSE 4
		END, position, name
	`, workID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	credits := []staffCredit{}
	for rows.Next() {
		var credit staffCredit
		if err := rows.Scan(&credit.Role, &credit.Name); err != nil {
			return nil, err
		}
		credits = append(credits, credit)
	}
	return credits, rows.Err()
}
