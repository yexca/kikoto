package metasync

import (
	"context"
	"encoding/json"
	"reflect"
	"strconv"
	"testing"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestApplyProductRecordsGenreIDsAndLearnsNamesByRequestLocale(t *testing.T) {
	db := openTestDB(t)
	s := NewDLsiteSyncer(db, fakeDLsiteClient{})
	originCode := testfixture.WorkCode(testfixture.PrefixRJ, 4)
	translatedCode := testfixture.WorkCode(testfixture.PrefixRJ, 50)
	if _, err := db.Exec(`INSERT INTO work (primary_code, title) VALUES (?, 'Translated title')`, translatedCode); err != nil {
		t.Fatal(err)
	}
	apply := func(code, locale string, genres ...dlsite.Genre) {
		t.Helper()
		raw, _ := json.Marshal(map[string]string{"workno": code, "product_name": "Example " + locale})
		product := dlsite.Product{WorkNo: code, ProductName: "Example " + locale, RequestLocale: locale, Genres: genres, Raw: raw}
		if err := s.applyProduct(context.Background(), workIDForTest(t, db, code), product); err != nil {
			t.Fatal(err)
		}
	}
	names := func() map[string]string {
		t.Helper()
		rows, err := db.Query(`SELECT genre_id, language, name FROM dlsite_genre_name`)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = rows.Close() }()
		got := map[string]string{}
		for rows.Next() {
			var id int64
			var language, name string
			if err := rows.Scan(&id, &language, &name); err != nil {
				t.Fatal(err)
			}
			got[language+"/"+strconv.FormatInt(id, 10)] = name
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return got
	}
	genreIDs := func(code string) []int64 {
		t.Helper()
		rows, err := db.Query(`SELECT genre_id FROM work_dlsite_genre WHERE work_id = ? ORDER BY genre_id`, workIDForTest(t, db, code))
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = rows.Close() }()
		ids := []int64{}
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				t.Fatal(err)
			}
			ids = append(ids, id)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return ids
	}

	// An edition requested in ja-jp reports Japanese names even when the
	// edition itself is in a language without its own locale.
	apply(originCode, "ja-jp",
		dlsite.Genre{ID: 206, Name: "少女", NameBase: "少女"},
		dlsite.Genre{ID: 0, Name: "Without id", NameBase: "Without id"})
	apply(translatedCode, "en-us",
		dlsite.Genre{ID: 206, Name: "Girl", NameBase: "少女"},
		dlsite.Genre{ID: 220, Name: "Older Girl", NameBase: "お姉さん"})

	if got := genreIDs(originCode); !reflect.DeepEqual(got, []int64{206}) {
		t.Fatalf("origin genre ids = %v, want [206]", got)
	}
	want := map[string]string{"ja-jp/206": "少女", "en-us/206": "Girl", "ja-jp/220": "お姉さん", "en-us/220": "Older Girl"}
	if got := names(); !reflect.DeepEqual(got, want) {
		t.Fatalf("learned names = %v, want %v", got, want)
	}

	// A later fetch replaces the edition's ids and the request locale's name.
	apply(translatedCode, "en-us", dlsite.Genre{ID: 206, Name: "Girls", NameBase: "少女"})
	if got := genreIDs(translatedCode); !reflect.DeepEqual(got, []int64{206}) {
		t.Fatalf("translated genre ids after refetch = %v, want [206]", got)
	}
	if got := names()["en-us/206"]; got != "Girls" {
		t.Fatalf("refetched en-us name = %q, want Girls", got)
	}
}
