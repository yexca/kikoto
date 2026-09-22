package searchtext

import "testing"

func TestFoldNormalizesWidthCaseKanaAndWhitespace(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"ＥＸＡＭＰＬＥ　Ｖｏｉｃｅ", "example voice"},
		{"ｻｻﾔｷ", "ささやき"},
		{"ササヤキボイス", "ささやきぼいす"},
		{"ヴォイス・ヽヾ", "ゔぉいす・ゝゞ"},
		{"ボーカル", "ぼーかる"},
		{"ÄÖ Straße", "äö straße"},
		{"  100%\t_off\n ", "100% _off"},
		{"癒し", "癒し"},
	}
	for _, tc := range cases {
		if got := Fold(tc.input); got != tc.want {
			t.Errorf("Fold(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}
