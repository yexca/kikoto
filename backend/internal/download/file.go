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
	if err := validateWriteRequest(contentLength, options); err != nil {
		return 0, err
	}
	file, tempPath, err := createTemporaryDownload(targetPath)
	if err != nil {
		return 0, err
	}
	keepTemp := false
	defer func() {
		_ = file.Close()
		if !keepTemp {
			_ = os.Remove(tempPath)
		}
	}()
	written, err := copyAndValidate(body, file, options)
	if err != nil {
		return 0, err
	}
	if err := publishDownload(file, tempPath, targetPath); err != nil {
		return 0, err
	}
	keepTemp = true
	return written, nil
}

func validateWriteRequest(contentLength int64, options Options) error {
	if options.MaxBytes <= 0 {
		return fmt.Errorf("download size limit must be positive")
	}
	if options.ExpectedBytes != nil && *options.ExpectedBytes < 0 {
		return fmt.Errorf("expected download size must not be negative")
	}
	if contentLength > options.MaxBytes {
		return LimitError{LimitBytes: options.MaxBytes, DeclaredBytes: contentLength}
	}
	if options.ExpectedBytes == nil {
		return nil
	}
	if *options.ExpectedBytes > options.MaxBytes {
		return LimitError{LimitBytes: options.MaxBytes, DeclaredBytes: *options.ExpectedBytes}
	}
	if contentLength >= 0 && contentLength != *options.ExpectedBytes {
		return SizeMismatchError{ExpectedBytes: *options.ExpectedBytes, ActualBytes: contentLength}
	}
	return nil
}

func createTemporaryDownload(targetPath string) (*os.File, string, error) {
	directory := filepath.Dir(targetPath)
	file, err := os.CreateTemp(directory, "."+filepath.Base(targetPath)+".download-*")
	if err != nil {
		return nil, "", err
	}
	if err := file.Chmod(0o644); err != nil {
		_ = file.Close()
		_ = os.Remove(file.Name())
		return nil, "", err
	}
	return file, file.Name(), nil
}

func copyAndValidate(body io.Reader, destination io.Writer, options Options) (int64, error) {
	if options.OnProgress != nil {
		options.OnProgress(0)
	}
	copyLimit := options.MaxBytes
	if copyLimit < math.MaxInt64 {
		copyLimit++
	}
	limited := &io.LimitedReader{R: body, N: copyLimit}
	written, err := io.Copy(&progressWriter{writer: destination, onProgress: options.OnProgress}, limited)
	if err != nil {
		return 0, err
	}
	if written > options.MaxBytes {
		return 0, LimitError{LimitBytes: options.MaxBytes, DeclaredBytes: written}
	}
	if options.ExpectedBytes != nil && written != *options.ExpectedBytes {
		return 0, SizeMismatchError{ExpectedBytes: *options.ExpectedBytes, ActualBytes: written}
	}
	return written, nil
}

func publishDownload(file *os.File, tempPath, targetPath string) error {
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(tempPath, targetPath)
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
