package textdecode

import (
	"context"
	"errors"
	"strings"
	"testing"

	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/japanese"
	unicodeencoding "golang.org/x/text/encoding/unicode"
)

func TestDecodeDetectsCommonJapaneseTextEncodings(t *testing.T) {
	expected := strings.Repeat("[00:01.00]\u30c6\u30b9\u30c8\u97f3\u58f0\u30c6\u30ad\u30b9\u30c8\n", 8)
	tests := []struct {
		name     string
		encoding encoding.Encoding
	}{
		{name: "shift_jis", encoding: japanese.ShiftJIS},
		{name: "euc_jp", encoding: japanese.EUCJP},
		{name: "iso_2022_jp", encoding: japanese.ISO2022JP},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			content, err := test.encoding.NewEncoder().Bytes([]byte(expected))
			if err != nil {
				t.Fatal(err)
			}
			got, err := Decode(context.Background(), content, "")
			if err != nil {
				t.Fatal(err)
			}
			if got != expected {
				t.Fatalf("decoded text = %q, want %q", got, expected)
			}
		})
	}
}

func TestDecodeUsesUnicodeBOM(t *testing.T) {
	expected := "\u30c6\u30b9\u30c8 text\n"
	for _, test := range []struct {
		name     string
		encoding encoding.Encoding
	}{
		{name: "utf_16_le", encoding: unicodeencoding.UTF16(unicodeencoding.LittleEndian, unicodeencoding.UseBOM)},
		{name: "utf_16_be", encoding: unicodeencoding.UTF16(unicodeencoding.BigEndian, unicodeencoding.UseBOM)},
	} {
		t.Run(test.name, func(t *testing.T) {
			content, err := test.encoding.NewEncoder().Bytes([]byte(expected))
			if err != nil {
				t.Fatal(err)
			}
			got, err := Decode(context.Background(), content, "")
			if err != nil {
				t.Fatal(err)
			}
			if got != expected {
				t.Fatalf("decoded text = %q, want %q", got, expected)
			}
		})
	}
}

func TestDecodeUsesDeclaredCharsetForShortLegacyText(t *testing.T) {
	expected := "\u30c6\u30b9\u30c8"
	content, err := japanese.ShiftJIS.NewEncoder().Bytes([]byte(expected))
	if err != nil {
		t.Fatal(err)
	}
	got, err := Decode(context.Background(), content, "text/plain; charset=Shift_JIS")
	if err != nil {
		t.Fatal(err)
	}
	if got != expected {
		t.Fatalf("decoded text = %q, want %q", got, expected)
	}
}

func TestDecodePrefersValidUTF8OverIncorrectLegacyHeader(t *testing.T) {
	expected := "UTF-8 \u30c6\u30ad\u30b9\u30c8"
	got, err := Decode(context.Background(), []byte(expected), "text/plain; charset=Shift_JIS")
	if err != nil {
		t.Fatal(err)
	}
	if got != expected {
		t.Fatalf("decoded text = %q, want %q", got, expected)
	}
}

func TestDecodeStopsWhileWaitingForDetectionSlot(t *testing.T) {
	for range cap(detectionSlots) {
		detectionSlots <- struct{}{}
	}
	defer func() {
		for range cap(detectionSlots) {
			<-detectionSlots
		}
	}()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := Decode(ctx, []byte{0x82, 0xa0}, "")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Decode error = %v, want context cancellation", err)
	}
}
