package testfixture

import (
	"database/sql"
	"fmt"
	"testing"
)

// SeedRecommendationScale uses popular tags and shared creators to expose
// unbounded entity recall, and four feedback densities to separate library
// growth from personal profile growth. It contains no provider or media data.
func SeedRecommendationScale(t testing.TB, db *sql.DB, works, users int) {
	t.Helper()
	if works < 1000 || works > 400000 || users < 20 || users > 100 {
		t.Fatal("scale fixture requires 1000..400000 works and 20..100 users")
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := tx.Exec(query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec("INSERT INTO file_source (id,code,display_name,source_type) VALUES (1,'example_local','Example Local','local_folder')")
	for id := 1; id <= 221; id++ {
		exec("INSERT INTO tag (id,namespace,normalized_name,display_name) VALUES (?,'metadata',?,?)", id, fmt.Sprintf("example-tag-%d", id), fmt.Sprintf("Example Tag %d", id))
	}
	for id := 1; id <= 40; id++ {
		exec("INSERT INTO person (id,display_name) VALUES (?,?)", id, fmt.Sprintf("Example Voice %d", id))
		exec("INSERT INTO person_alias (person_id,alias) VALUES (?,?)", id, fmt.Sprintf("Example Voice Alias %d", id))
	}
	for id := 1; id <= 10; id++ {
		exec("INSERT INTO party (id,display_name) VALUES (?,?)", id, fmt.Sprintf("Example Circle %d", id))
	}
	workStmt, err := tx.Prepare("INSERT INTO work (id,primary_code,title,created_at) VALUES (?,?,?,'2026-01-01 00:00:00')")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = workStmt.Close() }()
	for index := range works {
		if _, err := workStmt.Exec(index+1, HighCardinalityWorkCodeAt(index), fmt.Sprintf("Example Work %d", index)); err != nil {
			t.Fatal(err)
		}
	}
	exec("INSERT INTO work_source_presence (work_id,file_source_id,presence_type,availability) SELECT id,1,'local','available' FROM work")
	exec("INSERT INTO work_tag (work_id,tag_id,source) SELECT id,1,'test' FROM work")
	exec("INSERT INTO work_tag (work_id,tag_id,source) SELECT id,2+(id%20),'test' FROM work")
	exec("INSERT INTO work_tag (work_id,tag_id,source) SELECT id,22+(id%200),'test' FROM work")
	exec("INSERT INTO work_credit (work_id,person_id,role,source) SELECT id,1+(id%40),'voice_actor','test' FROM work")
	exec("INSERT INTO work_party (work_id,party_id,role,source) SELECT id,1+(id%10),'circle','test' FROM work")
	densities := [...]int{0, 10, 100, 1000}
	for user := 1; user <= users; user++ {
		exec("INSERT INTO user_account (id,username,display_name,role) VALUES (?,?,?,'user')", user, fmt.Sprintf("synthetic-user-%d", user), fmt.Sprintf("Example User %d", user))
		count := densities[(user-1)%len(densities)]
		for index := range count {
			status := "relisten"
			if index%4 == 0 {
				status = "paused"
			}
			exec("INSERT INTO user_work_state (user_id,work_id,listening_status,favorite) VALUES (?,?,?,?)", user, 1+(index*37+user*97)%works, status, index%7 == 0)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}
