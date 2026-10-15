// Package kikotohelper speaks the task endpoints of Kikoto Helper, a companion
// service that runs speech recognition and translation models on a local
// machine. Its transcription endpoint is the OpenAI-compatible one; this
// package covers what the helper adds on top: the info probe, the translation
// task and its error codes.
package kikotohelper

import (
	"encoding/json"
	"errors"
	"strings"
)

// Kind is the protocol kind of the helper's ASR and LLM presets.
const Kind = "kikoto-helper"

// APIVersion is the helper protocol version this server speaks.
const APIVersion = 1

const (
	// InfoPath answers without loading a model, so it doubles as the
	// connection test.
	InfoPath      = "/kikoto/v1/info"
	TranslatePath = "/kikoto/v1/translate"
)

// Default ports of the helper's two services.
const (
	ASRPort = 17656
	LLMPort = 17657
)

// Service names the info probe reports.
const (
	ServiceASR = "asr"
	ServiceLLM = "llm"
)

// ErrNotInstalled reports a helper without an installed runtime or model; the
// administrator installs one in the helper.
var ErrNotInstalled = errors.New("helper has no installed model")

// ErrIncompatible reports an answer that is not the expected helper service or
// protocol version.
var ErrIncompatible = errors.New("helper answered with an unsupported service or protocol version")

type Model struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Info is the part of the info probe this server uses. An ASR helper lists
// its installed models; an LLM helper names the one translation model it runs.
type Info struct {
	Service    string  `json:"service"`
	APIVersion int     `json:"api_version"`
	Installed  bool    `json:"installed"`
	Model      string  `json:"model"`
	ModelName  string  `json:"model_name"`
	Models     []Model `json:"models"`
}

// DecodeInfo reads the info probe of service. A helper whose model is not
// installed yet is ErrNotInstalled.
func DecodeInfo(data []byte, service string) (Info, error) {
	var info Info
	if json.Unmarshal(data, &info) != nil || info.Service != service || info.APIVersion != APIVersion {
		return Info{}, ErrIncompatible
	}
	if !info.Installed {
		return Info{}, ErrNotInstalled
	}
	return info, nil
}

// Error codes of rejections the helper reports in an OpenAI-style error body.
const (
	CodeNotInstalled            = "not_installed"
	CodeStartFailed             = "start_failed"
	CodeModelNotFound           = "model_not_found"
	CodeUnknownModel            = "unknown_model"
	CodeUnsupportedLanguagePair = "unsupported_language_pair"
)

// NotReady reports a rejection the administrator resolves in the helper, by
// installing or starting a model, rather than by retrying. The helper sends
// nothing to a model before it rejects a request this way.
func NotReady(code string) bool {
	switch code {
	case CodeNotInstalled, CodeStartFailed, CodeModelNotFound, CodeUnknownModel:
		return true
	}
	return false
}

// ErrorCode reads the code of an OpenAI-style error body,
// {"error": {"code": "..."}}, or returns empty when there is none.
func ErrorCode(data []byte) string {
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal(data, &body) != nil {
		return ""
	}
	code := strings.TrimSpace(body.Error.Code)
	if len(code) > 64 {
		return ""
	}
	return code
}
