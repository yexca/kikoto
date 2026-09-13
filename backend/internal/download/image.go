package download

import (
	"bytes"
	"errors"
	"io"
	"net/http"
)

var ErrImageType = errors.New("cover is not a supported raster image")

// ImageType identifies the inert raster formats supported by cover assets.
// Neither an upstream Content-Type nor a URL extension is a trusted type.
func ImageType(prefix []byte) (contentType, extension string, err error) {
	contentType = http.DetectContentType(prefix)
	switch contentType {
	case "image/jpeg":
		return contentType, ".jpg", nil
	case "image/png":
		return contentType, ".png", nil
	case "image/webp":
		return contentType, ".webp", nil
	default:
		return "", "", ErrImageType
	}
}

// WriteImage retains bounded, atomic publication while deriving the filename
// from the file signature. It does not decompress untrusted image data.
func WriteImage(body io.Reader, contentLength int64, targetStem string) error {
	options := Options{MaxBytes: CoverMaxBytes}
	if err := validateWriteRequest(contentLength, options); err != nil {
		return err
	}
	prefix := make([]byte, 512)
	n, err := io.ReadFull(body, prefix)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return err
	}
	prefix = prefix[:n]
	_, extension, err := ImageType(prefix)
	if err != nil {
		return err
	}
	_, err = WriteFile(io.MultiReader(bytes.NewReader(prefix), body), contentLength, targetStem+extension, options)
	return err
}
