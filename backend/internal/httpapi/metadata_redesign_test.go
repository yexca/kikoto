package httpapi

import (
	"bytes"
	"context"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/circleidentity"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestManualOverridePatchPreservesOmittedFieldsAndResetsOnlyExplicitFields(t *testing.T) {
	for _, reset := range []string{`{"title":null}`, `{"title":"  "}`} {
		t.Run(reset, func(t *testing.T) {
			fixture := newManualOverrideFixture(t, config.Config{})
			body := `{"title":"Authored title","circle":{"name":"Authored circle","externalId":"RG00000000"},"series":{"name":"Authored series","titleId":"SRI0000000000","circleExternalId":"RG00000000"},"voiceActors":[{"name":"Example Voice","personId":` + strconv.FormatInt(fixture.personID, 10) + `}]}`
			if response := updateManualOverridesRequest(t, fixture, body); response.Code != 200 {
				t.Fatal(response.Body.String())
			}
			if response := updateManualOverridesRequest(t, fixture, `{}`); response.Code != 200 {
				t.Fatal(response.Body.String())
			}
			if response := updateManualOverridesRequest(t, fixture, reset); response.Code != 200 {
				t.Fatal(response.Body.String())
			}
			got, err := fixture.server.loadWorkManualOverrides(context.Background(), fixture.workID)
			if err != nil {
				t.Fatal(err)
			}
			if got.Title != nil || got.Circle == nil || got.Series == nil || len(got.VoiceActors) != 1 {
				t.Fatalf("partial reset=%+v", got)
			}
			var circles, voices int
			if err := fixture.db.QueryRow("SELECT COUNT(*) FROM work_party WHERE work_id=? AND source='manual_override'", fixture.workID).Scan(&circles); err != nil {
				t.Fatal(err)
			}
			if err := fixture.db.QueryRow("SELECT COUNT(*) FROM work_credit WHERE work_id=? AND source='manual_override'", fixture.workID).Scan(&voices); err != nil {
				t.Fatal(err)
			}
			if circles != 1 || voices != 1 {
				t.Fatalf("omitted relations circles=%d voices=%d", circles, voices)
			}
			if response := updateManualOverridesRequest(t, fixture, `{"circle":null,"voiceActors":[]}`); response.Code != 200 {
				t.Fatal(response.Body.String())
			}
			got, err = fixture.server.loadWorkManualOverrides(context.Background(), fixture.workID)
			if err != nil {
				t.Fatal(err)
			}
			if got.Circle != nil || len(got.VoiceActors) != 0 || got.Series == nil {
				t.Fatalf("explicit reset=%+v", got)
			}
		})
	}
}

func TestMetadataEntryWritesRequireLibraryWriteAndDemoIsReadOnly(t *testing.T) {
	db := openMigratedTestDB(t)
	for _, role := range []string{"admin", "super_admin", "user"} {
		t.Run(role, func(t *testing.T) {
			result, err := db.Exec("INSERT INTO user_account(username,role) VALUES (?,?)", "metadata-"+role, role)
			if err != nil {
				t.Fatal(err)
			}
			userID, _ := result.LastInsertId()
			server := NewServer(db, config.Config{})
			request := httptest.NewRequest(http.MethodPost, "/api/metadata/tags", strings.NewReader(`{"name":"Synthetic custom"}`))
			request = request.WithContext(context.WithValue(request.Context(), currentUserKey, account.User{ID: userID, Role: role, Permissions: account.PermissionsForRole(role)}))
			response := httptest.NewRecorder()
			server.changeMetadataTag(response, request)
			want := 200
			if role == "user" {
				want = 403
			}
			if response.Code != want {
				t.Fatalf("role %s status %d body %s", role, response.Code, response.Body.String())
			}
		})
	}
	// Every new mutation family checks the same boundary before changing state.
	for _, mode := range []string{"regular", "demo"} {
		for _, change := range []struct {
			path, key string
			handler   func(http.ResponseWriter, *http.Request)
		}{
			{"/api/metadata/tags/1/merge", "tagId", NewServer(db, config.Config{}).changeMetadataTag},
			{"/api/metadata/circles/1/aliases", "partyId", NewServer(db, config.Config{}).changeMetadataCircle},
			{"/api/works/1/metadata-tags", "id", NewServer(db, config.Config{}).setWorkMetadataTags},
		} {
			t.Run(mode+change.path, func(t *testing.T) {
				server := NewServer(db, config.Config{Mode: config.ModeDemo})
				handler := change.handler
				permissions := account.PermissionsForRole("user")
				if mode == "demo" {
					permissions = account.PermissionsForRole("admin")
					handler = server.Routes().ServeHTTP
				}
				request := httptest.NewRequest(http.MethodPost, change.path, strings.NewReader(`{}`))
				request.SetPathValue(change.key, "1")
				request = request.WithContext(context.WithValue(request.Context(), currentUserKey, account.User{ID: 1, Permissions: permissions}))
				response := httptest.NewRecorder()
				handler(response, request)
				if response.Code != 403 {
					t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
				}
			})
		}
	}
}

func TestCircleManualNameSurvivesProviderRefreshAndAliasesSearch(t *testing.T) {
	fixture := newManualOverrideFixture(t, config.Config{})
	ctx := context.Background()
	tx, err := fixture.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec("UPDATE party SET provider_name=display_name WHERE id=?", fixture.partyID); err != nil {
		t.Fatal(err)
	}
	if err := circleidentity.RenameTx(ctx, tx, fixture.partyID, "Authored circle name"); err != nil {
		t.Fatal(err)
	}
	if err := circleidentity.AddAliasTx(ctx, tx, fixture.partyID, "Synthetic circle alias"); err != nil {
		t.Fatal(err)
	}
	if err := renameParty(ctx, tx, fixture.partyID, "Refreshed provider name"); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec("INSERT INTO work_party(work_id,party_id,role) VALUES (?,?,'circle')", fixture.workID, fixture.partyID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	circle, err := circleidentity.Load(ctx, fixture.db, fixture.partyID)
	if err != nil {
		t.Fatal(err)
	}
	if circle.DisplayName != "Authored circle name" || circle.ProviderName != "Refreshed provider name" {
		t.Fatalf("circle=%+v", circle)
	}
	if err := fixture.server.libraryStore.RefreshSearchIndex(ctx); err != nil {
		t.Fatal(err)
	}
	var names string
	if err := fixture.db.QueryRow("SELECT circle FROM work_search WHERE rowid=?", fixture.workID).Scan(&names); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(names, "synthetic circle alias") {
		t.Fatalf("circle search=%q", names)
	}
}

func TestFlatRemoteCoversMoveOnceAndExistingProviderCoverWins(t *testing.T) {
	root := t.TempDir()
	server := NewServer(openMigratedTestDB(t), config.Config{CacheRoot: root})
	code := testfixture.WorkCode(testfixture.PrefixRJ, 0)
	second := testfixture.WorkCode(testfixture.PrefixRJ, 1)
	coverRoot := filepath.Join(root, "cover")
	if err := os.MkdirAll(coverRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	var pngBytes bytes.Buffer
	if err := png.Encode(&pngBytes, image.NewRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{code, second} {
		if err := os.WriteFile(filepath.Join(coverRoot, value+".png"), pngBytes.Bytes(), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	existing := filepath.Join(coverRoot, filepath.FromSlash(coverAssetRelativePath(second, ".jpg")))
	if err := os.MkdirAll(filepath.Dir(existing), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(existing, []byte("provider cover"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := server.migrateFlatCoverCache(context.Background()); err != nil {
		t.Fatal(err)
	}
	moved := filepath.Join(coverRoot, filepath.FromSlash(coverAssetRelativePath(code, ".png")))
	if raw, err := os.ReadFile(moved); err != nil || !bytes.Equal(raw, pngBytes.Bytes()) {
		t.Fatalf("moved cover err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(coverRoot, code+".png")); !os.IsNotExist(err) {
		t.Fatal("flat cover was not moved")
	}
	if raw, err := os.ReadFile(existing); err != nil || string(raw) != "provider cover" {
		t.Fatal("provider cover changed")
	}
	if url := server.coverURL(code); !strings.Contains(url, "/RJ/000/"+code+".png") {
		t.Fatal(url)
	}
	if err := server.migrateFlatCoverCache(context.Background()); err != nil {
		t.Fatal(err)
	}
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("existing provider cover should skip remote request")
		w.WriteHeader(500)
	}))
	defer remote.Close()
	if err := server.downloadRemoteCover(context.Background(), remoteSourceForUse{Endpoint: fileSourceEndpoint{APIURL: remote.URL}}, second, remote.URL+"/cover"); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/assets/covers/"+coverAssetRelativePath(code, ".png"), nil)
	request.SetPathValue("path", coverAssetRelativePath(code, ".png"))
	response := httptest.NewRecorder()
	server.getCoverAsset(response, request)
	if response.Code != 200 {
		t.Fatalf("moved cover serve=%d", response.Code)
	}
}
