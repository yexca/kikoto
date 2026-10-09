package library

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/searchtext"
)

var ErrRecommendationNotReady = errors.New("recommendation catalog is preparing")

type recommendationFeature struct {
	Kind string `json:"kind"`
	ID   int64  `json:"id"`
}

func (f recommendationFeature) key() string { return f.Kind + ":" + strconv.FormatInt(f.ID, 10) }

func emptyRecommendationProfile() RecommendationProfile {
	return RecommendationProfile{Entities: map[string]recommendationProfileEntity{}, Names: map[string][]string{}}
}

func (s *Store) publishedRecommendationEpoch(ctx context.Context) (int64, error) {
	var epoch sql.NullInt64
	err := s.db.QueryRowContext(ctx, "SELECT published_epoch FROM recommendation_catalog_state WHERE id = 1").Scan(&epoch)
	if err != nil {
		return 0, err
	}
	if !epoch.Valid {
		return 0, ErrRecommendationNotReady
	}
	return epoch.Int64, nil
}

// RunRecommendationWorker owns durable projection repair and bounded cache
// reclamation. A failed/cancelled batch retains every queued change.
func (s *Store) RunRecommendationWorker(ctx context.Context) {
	timer := time.NewTimer(0)
	defer timer.Stop()
	batchSize, successes := 32, 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		processed, err := s.ProcessRecommendationCatalog(ctx, batchSize)
		if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
			batchSize = max(1, batchSize/2)
			successes = 0
		} else if err == nil && processed > 0 {
			successes++
			if successes == 4 {
				batchSize = min(64, batchSize*2)
				successes = 0
			}
		}
		if err != nil && ctx.Err() == nil {
			slog.Warn("recommendation catalog batch failed", "error", err)
		}
		if ctx.Err() != nil {
			return
		}
		if err := s.CleanupRecommendations(ctx, 128); err != nil && ctx.Err() == nil {
			slog.Warn("recommendation cleanup failed", "error", err)
		}
		delay := 2 * time.Second
		if err == nil && processed > 0 {
			delay = time.Millisecond
		}
		timer.Reset(delay)
	}
}

// ProcessRecommendationCatalog commits at most limit works and names. Published
// intervals remain readable while an unpublished epoch is built across batches.
func (s *Store) ProcessRecommendationCatalog(ctx context.Context, limit int) (int, error) {
	limit = min(max(limit, 1), 64)
	batchCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	select {
	case s.recommendationWrite <- struct{}{}:
		defer func() { <-s.recommendationWrite }()
	case <-batchCtx.Done():
		return 0, batchCtx.Err()
	}
	tx, err := s.db.BeginTx(batchCtx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	var published, building sql.NullInt64
	if err := tx.QueryRowContext(batchCtx, "SELECT published_epoch, building_epoch FROM recommendation_catalog_state WHERE id = 1").Scan(&published, &building); err != nil {
		return 0, err
	}
	var pending int
	if err := tx.QueryRowContext(batchCtx, "SELECT (SELECT COUNT(*) FROM recommendation_catalog_dirty) + (SELECT COUNT(*) FROM recommendation_name_dirty)").Scan(&pending); err != nil {
		return 0, err
	}
	if !building.Valid && (pending > 0 || !published.Valid) {
		var count int
		if published.Valid {
			if err := tx.QueryRowContext(batchCtx, "SELECT work_count FROM recommendation_catalog_epoch WHERE id = ?", published.Int64).Scan(&count); err != nil {
				return 0, err
			}
		}
		result, err := tx.ExecContext(batchCtx, "INSERT INTO recommendation_catalog_epoch(work_count) VALUES (?)", count)
		if err != nil {
			return 0, err
		}
		building.Int64, err = result.LastInsertId()
		if err != nil {
			return 0, err
		}
		building.Valid = true
		if _, err := tx.ExecContext(batchCtx, "UPDATE recommendation_catalog_state SET building_epoch = ? WHERE id = 1", building.Int64); err != nil {
			return 0, err
		}
	}
	if !building.Valid {
		return 0, tx.Commit()
	}
	rows, err := tx.QueryContext(batchCtx, "SELECT work_id FROM recommendation_catalog_dirty WHERE retry_after <= unixepoch() ORDER BY work_id LIMIT ?", limit)
	if err != nil {
		return 0, err
	}
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return 0, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return 0, err
	}
	for _, id := range ids {
		if err := projectRecommendationWork(batchCtx, tx, id, building.Int64); err != nil {
			_ = tx.Rollback()
			if ctx.Err() == nil {
				_, _ = s.db.ExecContext(ctx, "UPDATE recommendation_catalog_dirty SET retry_count = retry_count + 1, retry_after = unixepoch() + MIN(300, 30 * (1 << MIN(4, retry_count))) WHERE work_id = ?", id)
			}
			return 0, err
		}
	}
	rows, err = tx.QueryContext(batchCtx, "SELECT kind, entity_id FROM recommendation_name_dirty WHERE retry_after <= unixepoch() ORDER BY kind, entity_id LIMIT ?", limit)
	if err != nil {
		return 0, err
	}
	names := []recommendationFeature{}
	for rows.Next() {
		var f recommendationFeature
		if err := rows.Scan(&f.Kind, &f.ID); err != nil {
			_ = rows.Close()
			return 0, err
		}
		names = append(names, f)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return 0, err
	}
	for _, f := range names {
		if err := projectRecommendationNames(batchCtx, tx, f, building.Int64); err != nil {
			_ = tx.Rollback()
			if ctx.Err() == nil {
				_, _ = s.db.ExecContext(ctx, "UPDATE recommendation_name_dirty SET retry_count = retry_count + 1, retry_after = unixepoch() + MIN(300, 30 * (1 << MIN(4, retry_count))) WHERE kind = ? AND entity_id = ?", f.Kind, f.ID)
			}
			return 0, err
		}
	}
	if err := tx.QueryRowContext(batchCtx, "SELECT (SELECT COUNT(*) FROM recommendation_catalog_dirty) + (SELECT COUNT(*) FROM recommendation_name_dirty)").Scan(&pending); err != nil {
		return 0, err
	}
	var upstreamPending bool
	if err := tx.QueryRowContext(batchCtx, "SELECT EXISTS(SELECT 1 FROM work_metadata_tag_dirty)").Scan(&upstreamPending); err != nil {
		return 0, err
	}
	if pending == 0 && !upstreamPending {
		var changed bool
		if err := tx.QueryRowContext(batchCtx, "SELECT changed FROM recommendation_catalog_epoch WHERE id = ?", building.Int64).Scan(&changed); err != nil {
			return 0, err
		}
		if !changed && published.Valid {
			if _, err := tx.ExecContext(batchCtx, "UPDATE recommendation_catalog_state SET building_epoch = NULL WHERE id = 1"); err != nil {
				return 0, err
			}
			if _, err := tx.ExecContext(batchCtx, "DELETE FROM recommendation_catalog_epoch WHERE id = ?", building.Int64); err != nil {
				return 0, err
			}
			return len(ids) + len(names), tx.Commit()
		}
		if _, err := tx.ExecContext(batchCtx, "UPDATE recommendation_catalog_epoch SET published = 1 WHERE id = ?", building.Int64); err != nil {
			return 0, err
		}
		if _, err := tx.ExecContext(batchCtx, "UPDATE recommendation_catalog_state SET published_epoch = ?, building_epoch = NULL WHERE id = 1", building.Int64); err != nil {
			return 0, err
		}
	}
	return len(ids) + len(names), tx.Commit()
}

func projectRecommendationWork(ctx context.Context, tx *sql.Tx, id, epoch int64) error {
	var explore int64
	var primaryCode string
	err := tx.QueryRowContext(ctx, "SELECT recommendation_explore_key, primary_code FROM work WHERE id = ?", id).Scan(&explore, &primaryCode)
	exists := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	features := []recommendationFeature{}
	if exists {
		rows, err := tx.QueryContext(ctx, `SELECT 'tag', work_tag.tag_id FROM work_tag JOIN tag ON tag.id = work_tag.tag_id WHERE work_tag.work_id = ? AND tag.namespace IN ('dlsite', 'metadata') GROUP BY work_tag.tag_id
   UNION ALL SELECT 'voice', person_id FROM work_credit WHERE work_id = ? AND role = 'voice_actor' GROUP BY person_id
   UNION ALL SELECT 'circle', party_id FROM work_party WHERE work_id = ? AND role = 'circle' GROUP BY party_id`, id, id, id)
		if err != nil {
			return err
		}
		for rows.Next() {
			var f recommendationFeature
			if err := rows.Scan(&f.Kind, &f.ID); err != nil {
				_ = rows.Close()
				return err
			}
			features = append(features, f)
		}
		err = rows.Err()
		_ = rows.Close()
		if err != nil {
			return err
		}
	}
	sort.Slice(features, func(i, j int) bool { return features[i].key() < features[j].key() })
	raw, err := json.Marshal(features)
	if err != nil {
		return err
	}
	var oldRaw, oldCode string
	var from int64
	err = tx.QueryRowContext(ctx, "SELECT features_json, primary_code, valid_from FROM recommendation_catalog_work WHERE work_id = ? AND valid_to IS NULL", id).Scan(&oldRaw, &oldCode, &from)
	oldExists := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if exists != oldExists || (exists && (oldRaw != string(raw) || oldCode != primaryCode)) {
		old := []recommendationFeature{}
		if oldExists {
			if err := json.Unmarshal([]byte(oldRaw), &old); err != nil {
				return err
			}
		}
		deltas := map[recommendationFeature]int{}
		for _, f := range old {
			deltas[f]--
		}
		for _, f := range features {
			deltas[f]++
		}
		for f, delta := range deltas {
			if delta == 0 {
				continue
			}
			if err := updateRecommendationFrequency(ctx, tx, f, epoch, delta); err != nil {
				return err
			}
			if delta < 0 {
				if _, err := tx.ExecContext(ctx, "DELETE FROM recommendation_catalog_entity WHERE kind = ? AND entity_id = ? AND work_id = ? AND valid_from = ?", f.Kind, f.ID, id, epoch); err != nil {
					return err
				}
				if _, err := tx.ExecContext(ctx, "UPDATE recommendation_catalog_entity SET valid_to = ? WHERE kind = ? AND entity_id = ? AND work_id = ? AND valid_to IS NULL", epoch, f.Kind, f.ID, id); err != nil {
					return err
				}
			} else {
				if _, err := tx.ExecContext(ctx, "INSERT INTO recommendation_catalog_entity(kind, entity_id, work_id, explore_key, valid_from) VALUES (?, ?, ?, ?, ?)", f.Kind, f.ID, id, explore, epoch); err != nil {
					return err
				}
			}
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM recommendation_catalog_work WHERE work_id = ? AND valid_from = ?", id, epoch); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE recommendation_catalog_work SET valid_to = ? WHERE work_id = ? AND valid_to IS NULL", epoch, id); err != nil {
			return err
		}
		if exists {
			if _, err := tx.ExecContext(ctx, "INSERT INTO recommendation_catalog_work(work_id, primary_code, valid_from, features_json) VALUES (?, ?, ?, ?)", id, primaryCode, epoch, string(raw)); err != nil {
				return err
			}
		}
		delta := 0
		if exists && !oldExists {
			delta = 1
		}
		if !exists && oldExists {
			delta = -1
		}
		if _, err := tx.ExecContext(ctx, "UPDATE recommendation_catalog_epoch SET work_count = work_count + ?, changed = 1 WHERE id = ?", delta, epoch); err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, "DELETE FROM recommendation_catalog_dirty WHERE work_id = ?", id)
	return err
}

func updateRecommendationFrequency(ctx context.Context, tx *sql.Tx, f recommendationFeature, epoch int64, delta int) error {
	var count int
	err := tx.QueryRowContext(ctx, "SELECT work_count FROM recommendation_catalog_frequency WHERE kind = ? AND entity_id = ? AND valid_to IS NULL", f.Kind, f.ID).Scan(&count)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM recommendation_catalog_frequency WHERE kind = ? AND entity_id = ? AND valid_from = ?", f.Kind, f.ID, epoch); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE recommendation_catalog_frequency SET valid_to = ? WHERE kind = ? AND entity_id = ? AND valid_to IS NULL", epoch, f.Kind, f.ID); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO recommendation_catalog_frequency(kind, entity_id, valid_from, work_count) VALUES (?, ?, ?, ?)", f.Kind, f.ID, epoch, count+delta)
	return err
}

func projectRecommendationNames(ctx context.Context, tx *sql.Tx, f recommendationFeature, epoch int64) error {
	query := ""
	args := []any{f.ID}
	switch f.Kind {
	case "voice":
		query = "SELECT id, display_name FROM person WHERE id = ? UNION ALL SELECT person_id, alias FROM person_alias WHERE person_id = ?"
		args = append(args, f.ID)
	case "circle":
		query = "SELECT id, display_name FROM party WHERE id = ? UNION ALL SELECT id, manual_name FROM party WHERE id = ? UNION ALL SELECT id, provider_name FROM party WHERE id = ? UNION ALL SELECT party_id, alias FROM party_alias WHERE party_id = ?"
		args = []any{f.ID, f.ID, f.ID, f.ID}
	case "tag":
		query = `SELECT COALESCE(r.resolved_tag_id, t.id), t.display_name FROM tag t LEFT JOIN metadata_tag_resolution r ON r.source_tag_id = t.id WHERE t.id = ? AND t.namespace IN ('dlsite','metadata')
   UNION ALL SELECT r.resolved_tag_id, n.name FROM metadata_tag_name n JOIN metadata_tag_resolution r ON r.source_tag_id = n.tag_id WHERE n.tag_id = ?
   UNION ALL SELECT r.resolved_tag_id, n.name FROM metadata_tag_provider_name n JOIN metadata_tag_resolution r ON r.source_tag_id = n.tag_id WHERE n.tag_id = ?
   UNION ALL SELECT r.resolved_tag_id, n.name FROM dlsite_genre_name n JOIN metadata_tag m ON m.dlsite_genre_id = n.genre_id JOIN metadata_tag_resolution r ON r.source_tag_id = m.tag_id WHERE m.tag_id = ?`
		args = []any{f.ID, f.ID, f.ID, f.ID}
	default:
		return fmt.Errorf("invalid recommendation entity kind")
	}
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return err
	}
	names := map[string]int64{}
	for rows.Next() {
		var id int64
		var name string
		if err := rows.Scan(&id, &name); err != nil {
			_ = rows.Close()
			return err
		}
		if name = searchtext.Fold(name); name != "" {
			names[name] = id
		}
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return err
	}
	old := map[string]int64{}
	rows, err = tx.QueryContext(ctx, "SELECT name, entity_id FROM recommendation_catalog_name WHERE kind = ? AND source_id = ? AND valid_to IS NULL", f.Kind, f.ID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id int64
		var name string
		if err := rows.Scan(&name, &id); err != nil {
			_ = rows.Close()
			return err
		}
		old[name] = id
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return err
	}
	for name, id := range old {
		if names[name] == id {
			continue
		}
		if _, err := tx.ExecContext(ctx, "UPDATE recommendation_catalog_epoch SET changed = 1 WHERE id = ?", epoch); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM recommendation_catalog_name WHERE kind = ? AND source_id = ? AND name = ? AND valid_from = ?", f.Kind, f.ID, name, epoch); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE recommendation_catalog_name SET valid_to = ? WHERE kind = ? AND source_id = ? AND name = ? AND valid_to IS NULL", epoch, f.Kind, f.ID, name); err != nil {
			return err
		}
	}
	for name, id := range names {
		if old[name] == id {
			continue
		}
		if _, err := tx.ExecContext(ctx, "UPDATE recommendation_catalog_epoch SET changed = 1 WHERE id = ?", epoch); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO recommendation_catalog_name(kind,source_id,name,entity_id,valid_from) VALUES (?,?,?,?,?)", f.Kind, f.ID, name, id, epoch); err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, "DELETE FROM recommendation_name_dirty WHERE kind = ? AND entity_id = ?", f.Kind, f.ID)
	return err
}

func (s *Store) loadRecommendationFeatures(ctx context.Context, epoch int64, ids []int64) (map[int64][]recommendationFeature, error) {
	result := map[int64][]recommendationFeature{}
	for start := 0; start < len(ids); start += 256 {
		batch := ids[start:min(start+256, len(ids))]
		args := []any{epoch, epoch}
		for _, id := range batch {
			args = append(args, id)
		}
		rows, err := s.db.QueryContext(ctx, "SELECT c.work_id, c.features_json FROM recommendation_catalog_work c JOIN work w ON w.id = c.work_id AND w.primary_code = c.primary_code WHERE c.valid_from <= ? AND (c.valid_to IS NULL OR c.valid_to > ?) AND c.work_id IN ("+strings.TrimSuffix(strings.Repeat("?,", len(batch)), ",")+")", args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id int64
			var raw string
			if err := rows.Scan(&id, &raw); err != nil {
				_ = rows.Close()
				return nil, err
			}
			var features []recommendationFeature
			if err := json.Unmarshal([]byte(raw), &features); err != nil {
				_ = rows.Close()
				return nil, err
			}
			result[id] = features
			s.recommendationDiagnostics.featureRows.Add(1)
		}
		err = rows.Err()
		_ = rows.Close()
		if err != nil {
			return nil, err
		}
	}
	return result, nil
}
