package textdecode

import (
	"context"
	"errors"
	"strings"
	"testing"

	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/encoding/japanese"
	"golang.org/x/text/encoding/simplifiedchinese"
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

func TestDecodeDetectsSimplifiedChineseTextEncodings(t *testing.T) {
	// chardet names this family "GB-18030", which the IANA index does not know.
	expected := strings.Repeat("[00:01.00]\u6d4b\u8bd5\u97f3\u58f0\uff0c\u8fd9\u662f\u4e00\u6bb5\u793a\u4f8b\u6b4c\u8bcd\u3002\r\n", 8)
	for _, test := range []struct {
		name     string
		encoding encoding.Encoding
	}{
		{name: "gbk", encoding: simplifiedchinese.GBK},
		{name: "gb18030", encoding: simplifiedchinese.GB18030},
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

func TestDecodeKeepsUTF8LinesInLegacyText(t *testing.T) {
	legacy := strings.Repeat("[00:01.00]テスト音声テキストです。\r\n", 8)
	utf8Line := "[00:09.00]追記のテキスト。\r\n"
	encoded, err := japanese.ShiftJIS.NewEncoder().Bytes([]byte(legacy))
	if err != nil {
		t.Fatal(err)
	}
	content := append(encoded, utf8Line...)

	got, err := Decode(context.Background(), content, "")
	if err != nil {
		t.Fatal(err)
	}
	if want := legacy + utf8Line; got != want {
		t.Fatalf("decoded text = %q, want %q", got, want)
	}
}

func TestDecodeKeepsConfidentLegacyTextWithCorruptBytes(t *testing.T) {
	line := "[00:01.00]テスト音声テキストです。\r\n"
	encoded, err := japanese.ShiftJIS.NewEncoder().Bytes([]byte(strings.Repeat(line, 8)))
	if err != nil {
		t.Fatal(err)
	}
	// 0xFF is never valid in Shift_JIS; a single-byte charset would accept it
	// and turn the whole file into Latin or Cyrillic mojibake.
	content := append(append(append([]byte{}, encoded...), 0xff), encoded...)

	got, err := Decode(context.Background(), content, "")
	if err != nil {
		t.Fatal(err)
	}
	if want := strings.Repeat(line, 8) + "�" + strings.Repeat(line, 8); got != want {
		t.Fatalf("decoded text = %q, want %q", got, want)
	}
}

func TestDecodeTreatsDeclaredSingleByteCharsetAsHint(t *testing.T) {
	japaneseText := strings.Repeat("[00:01.00]テスト音声テキストです。\n", 4)
	shiftJIS, err := japanese.ShiftJIS.NewEncoder().Bytes([]byte(japaneseText))
	if err != nil {
		t.Fatal(err)
	}
	latinText := "[00:01.00]Café crème, naïve résumé à la façade.\n"
	latin1, err := charmap.ISO8859_1.NewEncoder().Bytes([]byte(latinText))
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name     string
		content  []byte
		expected string
	}{
		{name: "confident multibyte detection wins", content: shiftJIS, expected: japaneseText},
		{name: "declared charset kept for latin text", content: latin1, expected: latinText},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := Decode(context.Background(), test.content, "text/plain; charset=ISO-8859-1")
			if err != nil {
				t.Fatal(err)
			}
			if got != test.expected {
				t.Fatalf("decoded text = %q, want %q", got, test.expected)
			}
		})
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
