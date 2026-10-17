package metasync

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

type workTarget struct {
	ID          int64
	PrimaryCode string
}

// DLsiteSyncScope narrows a bulk synchronization to existing works. Nil
// WorkIDs selects every work; an empty non-nil list selects none. Full also
// refreshes works whose current snapshot would otherwise be skipped. A scope
// never adds a work: catalog codes without a work are not targets.
type DLsiteSyncScope struct {
	WorkIDs            []int64
	Full               bool
	RecheckUnavailable bool
}

// loadTargets returns the scoped works that need synchronization and how many
// syncable works the scope contains.
func (s *DLsiteSyncer) loadTargets(ctx context.Context, scope DLsiteSyncScope) ([]workTarget, int, error) {
	var wanted map[int64]bool
	if scope.WorkIDs != nil {
		wanted = make(map[int64]bool, len(scope.WorkIDs))
		for _, id := range scope.WorkIDs {
			wanted[id] = true
		}
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT
			work.id,
			work.primary_code,
			COALESCE((
				SELECT snapshot.snapshot_json
				FROM metadata_snapshot AS snapshot
				INNER JOIN metadata_provider AS snapshot_provider ON snapshot_provider.id = snapshot.provider_id
				WHERE snapshot.work_id = work.id AND snapshot_provider.code = 'dlsite'
				ORDER BY snapshot.fetched_at DESC, snapshot.id DESC
				LIMIT 1
			), ''),
			COALESCE((
				SELECT logical.canonical_code
				FROM work_edition AS edition
				INNER JOIN logical_work AS logical ON logical.id = edition.logical_work_id
				WHERE edition.work_id = work.id
			), ''),
			EXISTS (SELECT 1 FROM work_purchase_bonus AS bonus WHERE bonus.work_id = work.id)
		FROM work
		WHERE (? OR NOT EXISTS (
			SELECT 1
			FROM work_metadata_provider_state AS provider_state
			INNER JOIN metadata_provider AS state_provider ON state_provider.id = provider_state.provider_id
			WHERE provider_state.work_id = work.id
				AND state_provider.code = 'dlsite'
				AND provider_state.status = 'not_found'
		))
		ORDER BY work.id ASC
	`, scope.RecheckUnavailable)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = rows.Close() }()

	type snapshotTarget struct {
		target        workTarget
		snapshot      string
		canonicalCode string
		bonusDecided  bool
	}
	pending := []snapshotTarget{}
	for rows.Next() {
		var item snapshotTarget
		if err := rows.Scan(&item.target.ID, &item.target.PrimaryCode, &item.snapshot, &item.canonicalCode, &item.bonusDecided); err != nil {
			return nil, 0, err
		}
		item.target.PrimaryCode = strings.ToUpper(strings.TrimSpace(item.target.PrimaryCode))
		if wanted != nil && !wanted[item.target.ID] {
			continue
		}
		if dlsiteWorkNoPattern.MatchString(item.target.PrimaryCode) {
			pending = append(pending, item)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if err := rows.Close(); err != nil {
		return nil, 0, err
	}
	targets := []workTarget{}
	for _, item := range pending {
		if scope.Full || strings.TrimSpace(item.snapshot) == "" {
			targets = append(targets, item.target)
			continue
		}
		if s.purchaseBonusAutoLink && !item.bonusDecided && snapshotIsPurchaseBonus(item.snapshot) {
			// A stored purchase bonus without a detection decision is revisited
			// once, so existing bonuses are linked by a normal sync.
			targets = append(targets, item.target)
			continue
		}
		originCode := originCodeFromSnapshot(item.snapshot)
		if originCode == "" || strings.EqualFold(originCode, item.target.PrimaryCode) {
			continue
		}
		originReady, err := s.hasDLsiteSnapshotForCode(ctx, originCode)
		if err != nil {
			return nil, 0, err
		}
		if !strings.EqualFold(item.canonicalCode, originCode) || !originReady {
			targets = append(targets, item.target)
		}
	}
	return targets, len(pending), nil
}

func (s *DLsiteSyncer) hasDLsiteSnapshotForCode(ctx context.Context, code string) (bool, error) {
	var exists bool
	err := s.db.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM work
			INNER JOIN metadata_snapshot AS snapshot ON snapshot.work_id = work.id
			INNER JOIN metadata_provider AS provider ON provider.id = snapshot.provider_id
			WHERE UPPER(work.primary_code) = UPPER(?) AND provider.code = 'dlsite'
		)
	`, code).Scan(&exists)
	return exists, err
}

func (s *DLsiteSyncer) countSyncableWorks(ctx context.Context) (int, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT work.primary_code
		FROM work
		WHERE NOT EXISTS (
			SELECT 1
			FROM work_metadata_provider_state AS provider_state
			INNER JOIN metadata_provider AS provider ON provider.id = provider_state.provider_id
			WHERE provider_state.work_id = work.id
				AND provider.code = 'dlsite'
				AND provider_state.status = 'not_found'
		)
	`)
	if err != nil {
		return 0, err
	}
	defer func() { _ = rows.Close() }()
	total := 0
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			return 0, err
		}
		if dlsiteWorkNoPattern.MatchString(strings.ToUpper(strings.TrimSpace(code))) {
			total++
		}
	}
	return total, rows.Err()
}

func (s *DLsiteSyncer) workIDForCode(ctx context.Context, code string) (int64, bool, error) {
	var workID int64
	err := s.db.QueryRowContext(ctx, "SELECT id FROM work WHERE UPPER(primary_code) = UPPER(?)", code).Scan(&workID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return workID, true, nil
}
