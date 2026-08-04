package download

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteFilePublishesVerifiedBodyAndReportsProgress(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "media.bin")
	expected := int64(7)
	progress := []int64{}
	written, err := WriteFile(strings.NewReader("payload"), expected, target, Options{
		MaxBytes:      32,
		ExpectedBytes: &expected,
		OnProgress:    func(current int64) { progress = append(progress, current) },
	})
	if err != nil {
		t.Fatal(err)
	}
	if written != expected {
		t.Fatalf("written = %d, want %d", written, expected)
	}
	if len(progress) < 2 || progress[0] != 0 || progress[len(progress)-1] != expected {
		t.Fatalf("progress = %v", progress)
	}
	assertFileContent(t, target, "payload")
	assertNoTemporaryDownloads(t, directory)
}

func TestWriteFileRejectsDeclaredOrStreamedLimitWithoutReplacingTarget(t *testing.T) {
	for _, test := range []struct {
		name          string
		contentLength int64
	}{
		{name: "declared", contentLength: 8},
		{name: "streamed", contentLength: -1},
	} {
		t.Run(test.name, func(t *testing.T) {
			directory := t.TempDir()
			target := filepath.Join(directory, "media.bin")
			if err := os.WriteFile(target, []byte("old"), 0o644); err != nil {
				t.Fatal(err)
			}
			_, err := WriteFile(strings.NewReader("12345678"), test.contentLength, target, Options{MaxBytes: 7})
			if !errors.Is(err, ErrLimitExceeded) {
				t.Fatalf("error = %v, want limit error", err)
			}
			assertFileContent(t, target, "old")
			assertNoTemporaryDownloads(t, directory)
		})
	}
}

func TestWriteFileRejectsExpectedSizeMismatch(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "media.bin")
	expected := int64(8)
	_, err := WriteFile(strings.NewReader("short"), -1, target, Options{MaxBytes: 32, ExpectedBytes: &expected})
	if !errors.Is(err, ErrSizeMismatch) {
		t.Fatalf("error = %v, want size mismatch", err)
	}
	if _, statErr := os.Stat(target); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("target should not exist: %v", statErr)
	}
	assertNoTemporaryDownloads(t, directory)
}

func TestWriteFileReplacesExistingTargetOnlyAfterCompleteValidation(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "media.bin")
	if err := os.WriteFile(target, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := WriteFile(strings.NewReader("new"), 3, target, Options{MaxBytes: 8}); err != nil {
		t.Fatal(err)
	}
	assertFileContent(t, target, "new")
	assertNoTemporaryDownloads(t, directory)
}

func TestWriteFileCancellationRemovesPartialDataAndPreservesTarget(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "media.bin")
	if err := os.WriteFile(target, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	body := io.MultiReader(strings.NewReader("partial"), cancelledReader{})
	_, err := WriteFile(body, -1, target, Options{MaxBytes: 32})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want cancellation", err)
	}
	assertFileContent(t, target, "old")
	assertNoTemporaryDownloads(t, directory)
}

type cancelledReader struct{}

func (cancelledReader) Read([]byte) (int, error) { return 0, context.Canceled }

func assertFileContent(t *testing.T, path string, want string) {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != want {
		t.Fatalf("content = %q, want %q", content, want)
	}
}

func assertNoTemporaryDownloads(t *testing.T, directory string) {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(directory, ".*.download-*"))
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 0 {
		t.Fatalf("temporary downloads remain: %v", matches)
	}
}
