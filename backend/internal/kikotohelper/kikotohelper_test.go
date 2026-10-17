package kikotohelper

import (
	"errors"
	"testing"
)

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
		{`{"error":{"code":"abliterated_agreement_required"}}`, FailureAgreementRequired},
		{`{"error":{"code":"translation_failed","reason":"out_of_memory"}}`, ""},
		{`not json`, ""},
	} {
		if got := Failure(DecodeRejection([]byte(test.body))); got != test.want {
			t.Errorf("%s = %q, want %q", test.body, got, test.want)
		}
	}
}

func TestDecodeInfoNamesWhyAHelperCannotTranslateYet(t *testing.T) {
	for _, test := range []struct {
		body string
		want error
	}{
		{`{"service":"llm","api_version":1,"installed":true,"agreement_required":false,"model":"example-model"}`, nil},
		{`{"service":"llm","api_version":1,"installed":true,"model":"example-model"}`, nil},
		{`{"service":"llm","api_version":1,"installed":false,"agreement_required":true}`, ErrNotInstalled},
		{`{"service":"llm","api_version":1,"installed":true,"agreement_required":true,"model":"example-model"}`, ErrAgreementRequired},
		{`{"service":"llm","api_version":2,"installed":true}`, ErrIncompatible},
	} {
		if _, err := DecodeInfo([]byte(test.body), ServiceLLM); !errors.Is(err, test.want) {
			t.Errorf("%s = %v, want %v", test.body, err, test.want)
		}
	}
}
