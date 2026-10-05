package metadatatags_test

import (
	"context"
	"database/sql"
	"testing"

	"github.com/yexca/kikoto/backend/internal/metadatatags"
)

func TestLanguageManualNameWinsOverUniversalForCustomAndProviderTags(t *testing.T) {
	db := openTagDB(t)
	ctx := context.Background()
	execTag(t, db, "INSERT INTO dlsite_genre_name(genre_id,language,name) VALUES (1,'zh-cn','Example provider Chinese')")
	work := execTag(t, db, "INSERT INTO work(primary_code,title) VALUES ('RJ00000000','Example Work')")
	for _, custom := range []bool{true, false} {
		var id int64
		tagTx(t, db, func(tx *sql.Tx) error {
			var err error
			if custom {
				id, err = metadatatags.CreateTx(ctx, tx, "Example universal", 0)
			} else {
				id, err = metadatatags.EnsureGenreTx(ctx, tx, 1)
			}
			if err != nil {
				return err
			}
			if err = metadatatags.SetNameTx(ctx, tx, id, "", "Example universal", 0); err != nil {
				return err
			}
			if err = metadatatags.SetNameTx(ctx, tx, id, "zh-cn", "Example manual Chinese", 0); err != nil {
				return err
			}
			if err = metadatatags.RefreshNamesTx(ctx, tx, []string{"zh-cn", "en-us"}, id); err != nil {
				return err
			}
			return metadatatags.SetOverridesTx(ctx, tx, work, []metadatatags.Override{{TagID: id, Action: "add"}}, 0)
		})
		if got := readTag(t, db, id).DisplayName; got != "Example manual Chinese" {
			t.Fatalf("custom=%v display=%q", custom, got)
		}
		for _, language := range []string{"zh-cn", "en-us"} {
			want := "Example universal"
			if language == "zh-cn" {
				want = "Example manual Chinese"
			}
			names, err := metadatatags.Presentation(ctx, db, work, work, nil, language)
			if err != nil || len(names) != 1 || names[0] != want {
				t.Fatalf("custom=%v locale=%s names=%v %v", custom, language, names, err)
			}
		}
	}
}
