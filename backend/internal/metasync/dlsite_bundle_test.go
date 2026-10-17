package metasync

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"github.com/yexca/kikoto/backend/internal/dlsite"
)

func TestDeclaredBundleCodesReadsOnlyTheDeclaredCodes(t *testing.T) {
	raw := json.RawMessage(`{"product":{
		"workno":"RJ00000020",
		"work_pack_children":[
			{"workno":"RJ00000021","image":"//img.example.invalid/work/RJ00000099/RJ00000021_img.jpg"},
			"rj00000022",
			{"product_id":"RJ00000021"},
			"RJ00000020",
			"not a code"
		],
		"work_pack_parent":{"RJ00000030":{"title":"Example Bundle"}}
	}}`)
	members, bundles := declaredBundleCodes(raw, "RJ00000020")
	if want := []string{"RJ00000021", "RJ00000022"}; !reflect.DeepEqual(members, want) {
		t.Fatalf("members = %v, want %v", members, want)
	}
	if want := []string{"RJ00000030"}; !reflect.DeepEqual(bundles, want) {
		t.Fatalf("bundles = %v, want %v", bundles, want)
	}

	empty, none := declaredBundleCodes(json.RawMessage(`{"workno":"RJ00000020","work_pack_children":[],"work_pack_parent":[]}`), "RJ00000020")
	if len(empty) != 0 || len(none) != 0 {
		t.Fatalf("empty fields declared %v and %v", empty, none)
	}
}

func TestRecordDeclaredBundlesKeepsUserDecisions(t *testing.T) {
	db := openTestDB(t)
	if _, err := db.Exec(`INSERT INTO work_bundle_member (bundle_code, member_code, position, status, origin)
		VALUES ('RJ00000020', 'RJ00000022', 0, 'dismissed', 'user')`); err != nil {
		t.Fatal(err)
	}
	product := dlsite.Product{
		WorkNo:     "RJ00000020",
		ProductRaw: json.RawMessage(`{"workno":"RJ00000020","work_pack_children":["RJ00000021","RJ00000022"],"work_pack_parent":["RJ00000030"]}`),
	}
	syncer := NewDLsiteSyncer(db, fakeDLsiteClient{})
	for range 2 {
		if err := syncer.recordDeclaredBundles(context.Background(), product); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := db.Query("SELECT bundle_code, member_code, status, origin FROM work_bundle_member ORDER BY bundle_code, member_code")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	got := []string{}
	for rows.Next() {
		var bundle, member, status, origin string
		if err := rows.Scan(&bundle, &member, &status, &origin); err != nil {
			t.Fatal(err)
		}
		got = append(got, bundle+" "+member+" "+status+" "+origin)
	}
	want := []string{
		"RJ00000020 RJ00000021 linked detected",
		"RJ00000020 RJ00000022 dismissed user",
		"RJ00000030 RJ00000020 linked detected",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("rows = %v, want %v", got, want)
	}
}
