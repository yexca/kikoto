package download

import (
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
)

const CoverMaxBytes int64 = 20 << 20

var ErrLimitExceeded = errors.New("download size limit exceeded")
var ErrSizeMismatch = errors.New("download size does not match the expected size")

type Options struct {
	MaxBytes      int64
	ExpectedBytes *int64
	OnProgress    func(written int64)
}

type LimitError struct {
	LimitBytes    int64
	DeclaredBytes int64
}

func (e LimitError) Error() string {
	return fmt.Sprintf("%s: maximum is %d bytes", ErrLimitExceeded, e.LimitBytes)
}

func (e LimitError) Unwrap() error { return ErrLimitExceeded }

type SizeMismatchError struct {
	ExpectedBytes int64
	ActualBytes   int64
}

func (e SizeMismatchError) Error() string {
	return fmt.Sprintf("%s: expected %d bytes, received %d", ErrSizeMismatch, e.ExpectedBytes, e.ActualBytes)
}

func (e SizeMismatchError) Unwrap() error { return ErrSizeMismatch }

// WriteFile streams one response body into a temporary file, validates its
// size, and publishes it only after the complete body has been accepted.
func WriteFile(body io.Reader, contentLength int64, targetPath string, options Options) (int64, error) {
	if options.MaxBytes <= 0 {
		return 0, fmt.Errorf("download size limit must be positive")
	}
	if options.ExpectedBytes != nil && *options.ExpectedBytes < 0 {
		return 0, fmt.Errorf("expected download size must not be negative")
	}
	if contentLength > options.MaxBytes {
		return 0, LimitError{LimitBytes: options.MaxBytes, DeclaredBytes: contentLength}
	}
	if options.ExpectedBytes != nil {
		if *options.ExpectedBytes > options.MaxBytes {
			return 0, LimitError{LimitBytes: options.MaxBytes, DeclaredBytes: *options.ExpectedBytes}
		}
		if contentLength >= 0 && contentLength != *options.ExpectedBytes {
			return 0, SizeMismatchError{ExpectedBytes: *options.ExpectedBytes, ActualBytes: contentLength}
		}
	}

	directory := filepath.Dir(targetPath)
	file, err := os.CreateTemp(directory, "."+filepath.Base(targetPath)+".download-*")
	if err != nil {
		return 0, err
	}
	tempPath := file.Name()
	keepTemp := false
	defer func() {
		_ = file.Close()
		if !keepTemp {
			_ = os.Remove(tempPath)
		}
	}()
	if err := file.Chmod(0o644); err != nil {
		return 0, err
	}

	if options.OnProgress != nil {
		options.OnProgress(0)
	}
	copyLimit := options.MaxBytes
	if copyLimit < math.MaxInt64 {
		copyLimit++
	}
	limited := &io.LimitedReader{R: body, N: copyLimit}
	written, copyErr := io.Copy(&progressWriter{writer: file, onProgress: options.OnProgress}, limited)
	if copyErr != nil {
		return 0, copyErr
	}
	if written > options.MaxBytes {
		return 0, LimitError{LimitBytes: options.MaxBytes, DeclaredBytes: written}
	}
	if options.ExpectedBytes != nil && written != *options.ExpectedBytes {
		return 0, SizeMismatchError{ExpectedBytes: *options.ExpectedBytes, ActualBytes: written}
	}
	if err := file.Sync(); err != nil {
		return 0, err
	}
	if err := file.Close(); err != nil {
		return 0, err
	}
	if err := os.Rename(tempPath, targetPath); err != nil {
		return 0, err
	}
	keepTemp = true
	return written, nil
}

type progressWriter struct {
	writer     io.Writer
	written    int64
	onProgress func(int64)
}

func (w *progressWriter) Write(payload []byte) (int, error) {
	written, err := w.writer.Write(payload)
	w.written += int64(written)
	if written > 0 && w.onProgress != nil {
		w.onProgress(w.written)
	}
	return written, err
}
