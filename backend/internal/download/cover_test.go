package download

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func stagedCover(t *testing.T, root string, content []byte) string {
	t.Helper()
	file, err := os.CreateTemp(root, ".staged-*")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return file.Name()
}

func TestCoverPublicationUsesPortableRenameAndKeepsProviderPrecedence(t *testing.T) {
	root := t.TempDir()
	provider := bytes.Repeat([]byte("synthetic-provider"), 4096)
	remote := bytes.Repeat([]byte("synthetic-remote"), 4096)
	target := filepath.Join(root, "synthetic-work.jpg")
	if err := PublishCover(context.Background(), stagedCover(t, root, provider), target, true); err != nil {
		t.Fatal(err)
	}
	if err := PublishCover(context.Background(), stagedCover(t, root, remote), filepath.Join(root, "synthetic-work.png"), false); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(target)
	if err != nil || !bytes.Equal(got, provider) {
		t.Fatalf("provider cover was replaced: length=%d, error=%v", len(got), err)
	}
	if _, err := os.Stat(filepath.Join(root, "synthetic-work.png")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("remote extension published over provider: %v", err)
	}
	// If remote publication wins the race first, a later provider publication
	// removes its obsolete extension after the complete provider file appears.
	other := filepath.Join(root, "another-work.png")
	if err := PublishCover(context.Background(), stagedCover(t, root, remote), other, false); err != nil {
		t.Fatal(err)
	}
	providerTarget := filepath.Join(root, "another-work.jpg")
	if err := PublishCover(context.Background(), stagedCover(t, root, provider), providerTarget, true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(other); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("obsolete remote cover remains: %v", err)
	}
}

func TestConcurrentCoverPublicationExposesOnlyCompleteFiles(t *testing.T) {
	root := t.TempDir()
	provider := bytes.Repeat([]byte("synthetic-provider"), 4096)
	remote := bytes.Repeat([]byte("synthetic-remote"), 4096)
	providerStage := stagedCover(t, root, provider)
	remoteStages := []string{}
	for i := 0; i < 8; i++ {
		remoteStages = append(remoteStages, stagedCover(t, root, remote))
	}
	start := make(chan struct{})
	results := make(chan error, 9)
	var writers sync.WaitGroup
	for _, source := range remoteStages {
		writers.Go(func() {
			<-start
			results <- PublishCover(context.Background(), source, filepath.Join(root, "synthetic-work.png"), false)
		})
	}
	writers.Go(func() {
		<-start
		results <- PublishCover(context.Background(), providerStage, filepath.Join(root, "synthetic-work.jpg"), true)
	})
	done := make(chan struct{})
	readerErrors := make(chan error, 1)
	go func() {
		defer close(readerErrors)
		for {
			select {
			case <-done:
				return
			default:
			}
			for _, ext := range []string{".jpg", ".png"} {
				var got []byte
				err := retryCoverFilesystem(context.Background(), func() error {
					var readErr error
					got, readErr = os.ReadFile(filepath.Join(root, "synthetic-work"+ext))
					return readErr
				})
				if errors.Is(err, os.ErrNotExist) {
					continue
				}
				if err != nil {
					readerErrors <- err
					return
				}
				if !bytes.Equal(got, provider) && !bytes.Equal(got, remote) {
					readerErrors <- errors.New("reader observed partial cover contents")
					return
				}
			}
		}
	}()
	close(start)
	writers.Wait()
	close(results)
	close(done)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
	for err := range readerErrors {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(root, "synthetic-work.jpg"))
	if err != nil || !bytes.Equal(got, provider) {
		t.Fatalf("concurrent provider result length=%d, error=%v", len(got), err)
	}
	if _, err := os.Stat(filepath.Join(root, "synthetic-work.png")); !os.IsNotExist(err) {
		t.Fatalf("concurrent fallback survived provider: %v", err)
	}
}

func TestCanceledCoverPublicationDoesNotExposeStaging(t *testing.T) {
	root := t.TempDir()
	source := stagedCover(t, root, []byte("synthetic-complete"))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	target := filepath.Join(root, "synthetic-work.png")
	if err := PublishCover(ctx, source, target, false); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel error = %v", err)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("canceled file published: %v", err)
	}
	if _, err := os.Stat(source); err != nil {
		t.Fatalf("staging lost after cancellation: %v", err)
	}
}
