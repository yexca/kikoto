package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestServeMediaTextDetectsShiftJIS(t *testing.T) {
	dataRoot := t.TempDir()
	relPath := filepath.ToSlash(filepath.Join("Library", "RJ00000000", "notes.txt"))
	fullPath := filepath.Join(dataRoot, filepath.FromSlash(relPath))
	if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
		t.Fatal(err)
	}
	expected := strings.Repeat("\u30c6\u30b9\u30c8\u97f3\u58f0\u30c6\u30ad\u30b9\u30c8\n", 8)
	content := make([]byte, 0, len(expected))
	for range 8 {
		content = append(content,
			0x83, 0x65, 0x83, 0x58, 0x83, 0x67,
			0x89, 0xb9, 0x90, 0xba,
			0x83, 0x65, 0x83, 0x4c, 0x83, 0x58, 0x83, 0x67, '\n',
		)
	}
	if err := os.WriteFile(fullPath, content, 0o600); err != nil {
		t.Fatal(err)
	}

	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'example_local', 'Example Local', 'local_folder');
		INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000000', 'Example Work');
		INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES (1, 1, 'text', 'notes.txt', 'synthetic-notes');
		INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability)
		VALUES (1, 1, 1, 'local', ?, 'available');
	`, relPath); err != nil {
		t.Fatal(err)
	}

	server := NewServer(db, config.Config{DataRoot: dataRoot})
	request := httptest.NewRequest(http.MethodGet, "/api/media/1/text", nil)
	request.SetPathValue("id", "1")
	response := httptest.NewRecorder()
	server.serveMediaText(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("local text status = %d, body = %s", response.Code, response.Body.String())
	}
	var result struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Path != relPath || result.Content != expected {
		t.Fatalf("local text response = %#v, want path %q and decoded content %q", result, relPath, expected)
	}
}
