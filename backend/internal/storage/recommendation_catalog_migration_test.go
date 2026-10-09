package storage

import (
	"path/filepath"
	"testing"
)

// Upgrading must queue derived input without deleting personal state, durable
// history or large v5 caches in the migration transaction. Cache reclamation
// belongs to the bounded worker.
func TestRecommendationCatalogUpgradePreservesPersonalDataAndQueuesExistingWorks(t *testing.T) {
	source := filepath.Join("..", "..", "migrations")
	previous := copyNumberedMigrationsThrough(t, source, 62)
	db := openMigrationManagerDB(t)
	if err := Migrate(db, previous); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO user_account(id,username,display_name,role) VALUES (1,'synthetic-user','Example User','user');
		INSERT INTO work(id,primary_code,title) VALUES (1,'RJ00000000','Example Work'),(2,'RJ00000001','Example Other Work');
		INSERT INTO user_work_state(user_id,work_id,listening_status,favorite) VALUES (1,1,'relisten',1);
		INSERT INTO user_preference(user_id,recommendation_threshold) VALUES (1,60);
		INSERT INTO user_listening_session(user_id,session_id,work_id,listened_seconds) VALUES (1,'synthetic-listening',1,123);
		INSERT INTO recommendation_event(user_id,work_id,event_type) VALUES (1,1,'play');
		INSERT INTO recommendation_generation(id,user_id,algorithm_version,config_json,input_revision,user_revision) VALUES (1,1,'heuristic-v5','{}',1,1);
		INSERT INTO recommendation_snapshot(generation_id,work_id,score) VALUES (1,1,35),(1,2,35);
		INSERT INTO recommendation_client_session(user_id,session_id,generation_id) VALUES (1,'synthetic-v5',1);
	`); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(db, source); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"user_work_state", "user_preference", "user_listening_session", "recommendation_event", "recommendation_generation", "recommendation_client_session"} {
		var count int
		if err := db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 1 {
			t.Fatalf("upgrade changed %s: rows=%d", table, count)
		}
	}
	var snapshots, dirty, keys int
	if err := db.QueryRow("SELECT COUNT(*) FROM recommendation_snapshot").Scan(&snapshots); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM recommendation_catalog_dirty").Scan(&dirty); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM work WHERE recommendation_explore_key > 0").Scan(&keys); err != nil {
		t.Fatal(err)
	}
	if snapshots != 2 || dirty != 2 || keys != 2 {
		t.Fatalf("snapshot/dirty/exploration counts=%d/%d/%d", snapshots, dirty, keys)
	}
	var epoch any
	if err := db.QueryRow("SELECT published_epoch FROM recommendation_catalog_state WHERE id=1").Scan(&epoch); err != nil {
		t.Fatal(err)
	}
	if epoch != nil {
		t.Fatal("upgrade published an incomplete catalog")
	}
	if err := Migrate(db, source); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM recommendation_catalog_dirty").Scan(&dirty); err != nil {
		t.Fatal(err)
	}
	if dirty != 2 {
		t.Fatal("restart changed queued backfill")
	}
}
