package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
)

func kikoeruDatabaseUploadBody(t *testing.T, file []byte) (*bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	_ = writer.WriteField("userName", "synthetic-user")
	_ = writer.WriteField("acknowledgedRisk", "true")
	if file != nil {
		part, err := writer.CreateFormFile("file", "kikoeru.sqlite3")
		if err != nil {
			t.Fatal(err)
		}
		_, _ = part.Write(file)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return &body, writer.FormDataContentType()
}

// pausedReader delivers its first half, waits, then delivers the rest, like an
// upload over a slow link.
type pausedReader struct {
	data   []byte
	pause  time.Duration
	offset int
	paused bool
}

func (reader *pausedReader) Read(target []byte) (int, error) {
	if reader.offset >= len(reader.data) {
		return 0, io.EOF
	}
	limit := len(reader.data)
	if !reader.paused {
		limit = len(reader.data) / 2
		if reader.offset >= limit {
			reader.paused = true
			time.Sleep(reader.pause)
			limit = len(reader.data)
		}
	}
	count := copy(target, reader.data[reader.offset:limit])
	reader.offset += count
	return count, nil
}

// The database upload has its own window: a body that arrives more slowly than
// the server's read timeout for ordinary requests is still received in full.
func TestKikoeruDatabaseUploadOutlivesTheServerReadTimeout(t *testing.T) {
	server := NewServer(nil, config.Config{TempDir: t.TempDir()})
	upstream := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		server.importKikoeruDatabase(w, r.WithContext(context.WithValue(r.Context(), currentUserKey, kikoeruImportUser)))
	}))
	upstream.Config.ReadTimeout = 300 * time.Millisecond
	upstream.Start()
	defer upstream.Close()

	body, contentType := kikoeruDatabaseUploadBody(t, bytes.Repeat([]byte("not a database "), 4096))
	request, err := http.NewRequest(http.MethodPost, upstream.URL+kikoeruDatabaseImportPath, &pausedReader{data: body.Bytes(), pause: 900 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", contentType)
	response, err := upstream.Client().Do(request)
	if err != nil {
		t.Fatalf("slow upload was cut off: %v", err)
	}
	defer func() { _ = response.Body.Close() }()
	var result errorResponseBody
	_ = json.NewDecoder(response.Body).Decode(&result)
	// The whole file arrived, so the answer is about its content.
	if response.StatusCode != http.StatusBadRequest || result.Code != "kikoeru_database_invalid" {
		t.Fatalf("slow upload = %d %+v, want the fully received file to be judged as a database", response.StatusCode, result)
	}
}

type failingReader struct {
	data []byte
	err  error
}

func (reader *failingReader) Read(target []byte) (int, error) {
	if len(reader.data) == 0 {
		return 0, reader.err
	}
	count := copy(target, reader.data)
	reader.data = reader.data[count:]
	return count, nil
}

// An upload that fails is reported as an upload problem, never as a wrong
// address or sign-in, which an upload does not have.
func TestKikoeruDatabaseUploadFailuresAreReportedAsUploadProblems(t *testing.T) {
	server := NewServer(nil, config.Config{})
	post := func(body io.Reader, contentType string) (int, errorResponseBody) {
		request := httptest.NewRequest(http.MethodPost, kikoeruDatabaseImportPath, body)
		request.Header.Set("Content-Type", contentType)
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, kikoeruImportUser))
		response := httptest.NewRecorder()
		server.importKikoeruDatabase(response, request)
		var result errorResponseBody
		_ = json.Unmarshal(response.Body.Bytes(), &result)
		return response.Code, result
	}

	complete, contentType := kikoeruDatabaseUploadBody(t, bytes.Repeat([]byte("x"), 8192))
	truncated := &failingReader{data: complete.Bytes()[:complete.Len()/2], err: io.ErrUnexpectedEOF}
	if status, result := post(truncated, contentType); status != http.StatusRequestTimeout || result.Code != "kikoeru_upload_interrupted" || !result.Retryable {
		t.Fatalf("interrupted upload = %d %+v, want a retryable 408 kikoeru_upload_interrupted", status, result)
	}

	withoutFile, contentType := kikoeruDatabaseUploadBody(t, nil)
	if status, result := post(withoutFile, contentType); status != http.StatusBadRequest || result.Code != "kikoeru_upload_invalid" {
		t.Fatalf("upload without a file = %d %+v, want 400 kikoeru_upload_invalid", status, result)
	}
	if status, result := post(bytes.NewReader([]byte("{}")), "application/json"); status != http.StatusBadRequest || result.Code != "kikoeru_upload_invalid" {
		t.Fatalf("non-multipart upload = %d %+v, want 400 kikoeru_upload_invalid", status, result)
	}
}
