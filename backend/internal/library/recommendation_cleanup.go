package library

import (
	"context"
	"database/sql"
	"fmt"
)

// CleanupRecommendations bounds every delete, including legacy snapshots and
// staged sparse states, before removing their owning generation. Epoch intervals
// are reclaimed only below the oldest retained generation's feature version.
func (s *Store) CleanupRecommendations(ctx context.Context, limit int) error {
	limit = min(max(limit, 1), 256)
	return s.withRecommendationWrite(ctx, func(tx *sql.Tx) error {
		statements := []string{
			`UPDATE recommendation_snapshot_state SET current_generation_id = NULL WHERE user_id IN (SELECT st.user_id FROM recommendation_snapshot_state st JOIN recommendation_generation g ON g.id = st.current_generation_id WHERE g.created_at < datetime('now','-90 days') AND NOT EXISTS (SELECT 1 FROM recommendation_client_session s WHERE s.generation_id = g.id AND s.created_at >= ` + recommendationSessionRetentionSQL + `) LIMIT ?)`,
			`DELETE FROM recommendation_client_session WHERE rowid IN (SELECT s.rowid FROM recommendation_client_session s LEFT JOIN recommendation_generation g ON g.id = s.generation_id WHERE s.created_at < ` + recommendationSessionRetentionSQL + ` OR g.algorithm_version <> 'heuristic-v6' LIMIT ?)`,
			`DELETE FROM recommendation_snapshot WHERE rowid IN (SELECT rowid FROM recommendation_snapshot LIMIT ?)`,
			`UPDATE recommendation_snapshot_state SET current_generation_id = NULL WHERE user_id IN (SELECT st.user_id FROM recommendation_snapshot_state st JOIN recommendation_generation g ON g.id = st.current_generation_id WHERE g.algorithm_version <> 'heuristic-v6' LIMIT ?)`,
		}
		for _, query := range statements {
			if _, err := tx.ExecContext(ctx, query, limit); err != nil {
				return err
			}
		}
		abandoned := `(g.ready = 0 AND g.created_at < datetime('now','-1 hour')) OR (NOT EXISTS (SELECT 1 FROM recommendation_client_session s WHERE s.generation_id = g.id) AND NOT EXISTS (SELECT 1 FROM recommendation_snapshot_state st WHERE st.current_generation_id = g.id) AND g.created_at < datetime('now','-1 hour'))`
		for _, table := range []string{"recommendation_generation_state", "recommendation_query_candidate", "recommendation_query_checkpoint"} {
			join := "JOIN recommendation_generation g ON g.id = cache.generation_id"
			if table != "recommendation_generation_state" {
				join = "JOIN recommendation_query_context q ON q.id = cache.context_id JOIN recommendation_generation g ON g.id = q.generation_id"
			}
			query := "DELETE FROM " + table + " WHERE rowid IN (SELECT cache.rowid FROM " + table + " cache " + join + " WHERE (" + abandoned + ") LIMIT ?)"
			if _, err := tx.ExecContext(ctx, query, limit); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM recommendation_generation WHERE id IN (
   SELECT g.id FROM recommendation_generation g WHERE (`+abandoned+`)
   AND NOT EXISTS (SELECT 1 FROM recommendation_generation_state st WHERE st.generation_id = g.id)
   AND NOT EXISTS (SELECT 1 FROM recommendation_snapshot st WHERE st.generation_id = g.id)
   AND NOT EXISTS (SELECT 1 FROM recommendation_query_context q JOIN recommendation_query_candidate c ON c.context_id = q.id WHERE q.generation_id = g.id)
   AND NOT EXISTS (SELECT 1 FROM recommendation_query_context q JOIN recommendation_query_checkpoint c ON c.context_id = q.id WHERE q.generation_id = g.id)
   LIMIT ?)`, limit); err != nil {
			return err
		}
		var floor sql.NullInt64
		if err := tx.QueryRowContext(ctx, `SELECT MIN(epoch) FROM (
   SELECT published_epoch epoch FROM recommendation_catalog_state
   UNION ALL SELECT building_epoch FROM recommendation_catalog_state
   UNION ALL SELECT catalog_epoch FROM recommendation_generation WHERE catalog_epoch IS NOT NULL
  )`).Scan(&floor); err != nil {
			return err
		}
		if !floor.Valid {
			return nil
		}
		for _, table := range []string{"recommendation_catalog_work", "recommendation_catalog_entity", "recommendation_catalog_frequency", "recommendation_catalog_name"} {
			query := fmt.Sprintf("DELETE FROM %s WHERE rowid IN (SELECT rowid FROM %s WHERE valid_to <= ? LIMIT ?)", table, table)
			if _, err := tx.ExecContext(ctx, query, floor.Int64, limit); err != nil {
				return err
			}
		}
		_, err := tx.ExecContext(ctx, `DELETE FROM recommendation_catalog_epoch WHERE id IN (SELECT e.id FROM recommendation_catalog_epoch e
   WHERE e.id < ? AND NOT EXISTS (SELECT 1 FROM recommendation_generation g WHERE g.catalog_epoch = e.id)
   AND e.id <> COALESCE((SELECT published_epoch FROM recommendation_catalog_state),0)
   AND e.id <> COALESCE((SELECT building_epoch FROM recommendation_catalog_state),0) LIMIT ?)`, floor.Int64, limit)
		return err
	})
}
