package textdecode

import (
	"bytes"
	"context"
	"mime"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/saintfish/chardet"
	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/encoding/ianaindex"
	"golang.org/x/text/encoding/japanese"
	unicodeencoding "golang.org/x/text/encoding/unicode"
	"golang.org/x/text/encoding/unicode/utf32"
)

var detectionSlots = make(chan struct{}, 2)

var (
	utf8BOM    = []byte{0xef, 0xbb, 0xbf}
	utf16BEBOM = []byte{0xfe, 0xff}
	utf16LEBOM = []byte{0xff, 0xfe}
	utf32BEBOM = []byte{0x00, 0x00, 0xfe, 0xff}
	utf32LEBOM = []byte{0xff, 0xfe, 0x00, 0x00}
)

// Decode converts bounded text-file bytes to UTF-8 without changing the source.
func Decode(ctx context.Context, content []byte, contentType string) (string, error) {
	if len(content) == 0 {
		return "", nil
	}
	if decoded, ok := decodeBOM(content); ok {
		return decoded, nil
	}
	if bytes.HasPrefix(content, utf8BOM) {
		content = content[len(utf8BOM):]
	}

	declared := declaredCharset(contentType)
	if isWideUnicodeCharset(declared) {
		if decoded, ok := decodeCharset(content, declared); ok {
			return decoded, nil
		}
	}
	if hasISO2022JPEscape(content) {
		if decoded, ok := decodeBytes(content, japanese.ISO2022JP); ok {
			return decoded, nil
		}
	}
	if utf8.Valid(content) {
		return string(content), nil
	}
	if declared != "" {
		if decoded, ok := decodeCharset(content, declared); ok && !strings.ContainsRune(decoded, utf8.RuneError) {
			return decoded, nil
		}
	}

	// The detector evaluates many recognizers concurrently, so cap simultaneous
	// detections while allowing UTF-8 and BOM-marked files to stay on the fast path.
	select {
	case detectionSlots <- struct{}{}:
		defer func() { <-detectionSlots }()
	case <-ctx.Done():
		return "", ctx.Err()
	}

	results, err := chardet.NewTextDetector().DetectAll(content)
	if err == nil {
		sort.Slice(results, func(i, j int) bool {
			if results[i].Confidence != results[j].Confidence {
				return results[i].Confidence > results[j].Confidence
			}
			leftPriority := charsetPriority(results[i].Charset)
			rightPriority := charsetPriority(results[j].Charset)
			if leftPriority != rightPriority {
				return leftPriority < rightPriority
			}
			return strings.ToLower(results[i].Charset) < strings.ToLower(results[j].Charset)
		})
		for _, result := range results {
			decoded, ok := decodeCharset(content, result.Charset)
			if ok && !strings.ContainsRune(decoded, utf8.RuneError) {
				return decoded, nil
			}
		}
	}

	if decoded, ok := decodeBytes(content, japanese.ShiftJIS); ok && !strings.ContainsRune(decoded, utf8.RuneError) {
		return decoded, nil
	}
	if decoded, ok := decodeBytes(content, charmap.Windows1252); ok {
		return decoded, nil
	}
	return strings.ToValidUTF8(string(content), string(utf8.RuneError)), nil
}

func decodeBOM(content []byte) (string, bool) {
	switch {
	case bytes.HasPrefix(content, utf32BEBOM):
		return decodeBytes(content, utf32.UTF32(utf32.BigEndian, utf32.ExpectBOM))
	case bytes.HasPrefix(content, utf32LEBOM):
		return decodeBytes(content, utf32.UTF32(utf32.LittleEndian, utf32.ExpectBOM))
	case bytes.HasPrefix(content, utf16BEBOM):
		return decodeBytes(content, unicodeencoding.UTF16(unicodeencoding.BigEndian, unicodeencoding.ExpectBOM))
	case bytes.HasPrefix(content, utf16LEBOM):
		return decodeBytes(content, unicodeencoding.UTF16(unicodeencoding.LittleEndian, unicodeencoding.ExpectBOM))
	case bytes.HasPrefix(content, utf8BOM) && utf8.Valid(content[len(utf8BOM):]):
		return string(content[len(utf8BOM):]), true
	default:
		return "", false
	}
}

func declaredCharset(contentType string) string {
	if strings.TrimSpace(contentType) == "" {
		return ""
	}
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(params["charset"])
}

func decodeCharset(content []byte, charset string) (string, bool) {
	switch normalizeCharset(charset) {
	case "utf-8", "utf8", "us-ascii":
		if !utf8.Valid(content) {
			return "", false
		}
		return string(content), true
	case "utf-32", "utf32", "utf-32be", "utf32be":
		return decodeBytes(content, utf32.UTF32(utf32.BigEndian, utf32.UseBOM))
	case "utf-32le", "utf32le":
		return decodeBytes(content, utf32.UTF32(utf32.LittleEndian, utf32.UseBOM))
	case "cp932", "ms932", "shift-jis", "shiftjis", "sjis", "windows-31j":
		return decodeBytes(content, japanese.ShiftJIS)
	}
	charsetEncoding, err := ianaindex.IANA.Encoding(charset)
	if err != nil || charsetEncoding == nil {
		charsetEncoding, err = ianaindex.MIME.Encoding(charset)
	}
	if err != nil || charsetEncoding == nil {
		return "", false
	}
	return decodeBytes(content, charsetEncoding)
}

func decodeBytes(content []byte, charset encoding.Encoding) (string, bool) {
	decoded, err := charset.NewDecoder().Bytes(content)
	if err != nil || !utf8.Valid(decoded) {
		return "", false
	}
	return string(decoded), true
}

func isWideUnicodeCharset(charset string) bool {
	normalized := normalizeCharset(charset)
	return strings.HasPrefix(normalized, "utf-16") || strings.HasPrefix(normalized, "utf16") ||
		strings.HasPrefix(normalized, "utf-32") || strings.HasPrefix(normalized, "utf32")
}

func hasISO2022JPEscape(content []byte) bool {
	return bytes.Contains(content, []byte{0x1b, '$', '@'}) ||
		bytes.Contains(content, []byte{0x1b, '$', 'B'}) ||
		bytes.Contains(content, []byte{0x1b, '$', '(', 'D'})
}

func normalizeCharset(charset string) string {
	return strings.ReplaceAll(strings.ToLower(strings.TrimSpace(charset)), "_", "-")
}

func charsetPriority(charset string) int {
	switch normalizeCharset(charset) {
	case "shift-jis":
		return 0
	case "euc-jp":
		return 1
	case "iso-2022-jp":
		return 2
	case "gb-18030", "gb18030":
		return 3
	case "big5":
		return 4
	case "euc-kr":
		return 5
	default:
		return 100
	}
}
