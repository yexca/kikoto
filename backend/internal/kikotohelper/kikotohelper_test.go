package kikotohelper

import "testing"

func TestFailureNamesTheCauseOfAHelperRejection(t *testing.T) {
	for _, test := range []struct {
		body, want string
	}{
		{`{"error":{"code":"not_installed"}}`, FailureNotReady},
		{`{"error":{"code":"model_not_found"}}`, FailureNotReady},
		{`{"error":{"code":"unknown_model"}}`, FailureNotReady},
		// An older helper reports a start failure without a reason.
		{`{"error":{"code":"start_failed"}}`, FailureStartFailed},
		{`{"error":{"code":"start_failed","reason":"out_of_memory"}}`, FailureOutOfMemory},
		{`{"error":{"code":"start_failed","reason":"example_unknown_reason"}}`, FailureStartFailed},
		{`{"error":{"code":"unsupported_language_pair"}}`, FailureUnsupportedLanguagePair},
		{`{"error":{"code":"translation_failed","reason":"out_of_memory"}}`, ""},
		{`not json`, ""},
	} {
		if got := Failure(DecodeRejection([]byte(test.body))); got != test.want {
			t.Errorf("%s = %q, want %q", test.body, got, test.want)
		}
	}
}
