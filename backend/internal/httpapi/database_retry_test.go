package httpapi

import (
	"context"
	"errors"
	"testing"
)

func TestWithDatabaseBusyRetryRetriesBusyErrors(t *testing.T) {
	attempts := 0
	err := withDatabaseBusyRetry(context.Background(), func() error {
		attempts++
		if attempts < 3 {
			return errors.New("database is busy")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if attempts != 3 {
		t.Fatalf("attempts = %d, want 3", attempts)
	}
}

func TestWithDatabaseBusyRetryDoesNotRetryOtherErrors(t *testing.T) {
	attempts := 0
	want := errors.New("write failed")
	err := withDatabaseBusyRetry(context.Background(), func() error {
		attempts++
		return want
	})
	if !errors.Is(err, want) {
		t.Fatalf("error = %v, want %v", err, want)
	}
	if attempts != 1 {
		t.Fatalf("attempts = %d, want 1", attempts)
	}
}
