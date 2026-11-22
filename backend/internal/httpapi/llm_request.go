package httpapi

import (
	"errors"
	"net/http"

	"github.com/yexca/kikoto/backend/internal/kikotohelper"
	"github.com/yexca/kikoto/backend/internal/llm"
)

type llmRequestError struct{ Code, Message string }

func (e llmRequestError) Error() string     { return e.Message }
func llmInvalid(code, message string) error { return llmRequestError{code, message} }

var errLLMUnsupportedLanguagePair = llmInvalid("llm_unsupported_language_pair", "This model does not support that translation direction.")

// llmHelperRejection names a Kikoto Helper rejection that retrying unchanged
// cannot fix, as a kikotohelper failure code, or returns empty. The helper
// rejects these before any model receives the request.
func llmHelperRejection(err error) string {
	var rejected llm.UpstreamError
	if !errors.As(err, &rejected) {
		return ""
	}
	return kikotohelper.Failure(rejected.Rejection)
}

func writeLLMRequestError(w http.ResponseWriter, err error) {
	var invalid llmRequestError
	if errors.As(err, &invalid) {
		writeAPIError(w, 422, invalid.Code, invalid.Message, false)
		return
	}
	writeAPIError(w, 502, "llm_translation_failed", "Translation failed. Check the configured endpoint and model.", false)
}
