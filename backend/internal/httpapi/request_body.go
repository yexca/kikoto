package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

// decodeOptionalJSONBody decodes a JSON request body that the caller may
// omit. An absent or empty body leaves dst as it is and reports true. A
// malformed body, or a value of the wrong type, answers 400 and reports false,
// so a mistyped field never runs the operation with its default instead.
func decodeOptionalJSONBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	if r.Body == nil {
		return true
	}
	return decodeOptionalJSON(w, json.NewDecoder(r.Body), dst)
}

// decodeOptionalJSON is decodeOptionalJSONBody for a decoder the caller has
// bounded or made strict.
func decodeOptionalJSON(w http.ResponseWriter, decoder *json.Decoder, dst any) bool {
	err := decoder.Decode(dst)
	if err == nil || errors.Is(err, io.EOF) {
		return true
	}
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		writeAPIError(w, http.StatusRequestEntityTooLarge, "invalid_request", "request body too large", false)
		return false
	}
	writeAPIError(w, http.StatusBadRequest, "invalid_request", jsonBodyErrorMessage(err), false)
	return false
}
