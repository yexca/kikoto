// Package kikotohelper speaks the task endpoints of Kikoto Helper, a companion
// service that runs speech recognition and translation models on a local
// machine. Its transcription endpoint is the OpenAI-compatible one; this
// package covers what the helper adds on top: the info probe, the translation
// task and its error codes.
package kikotohelper

import (
	"bytes"
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

// ErrAgreementRequired reports a helper whose selected translation model is
// used only after the administrator accepts its risk notice in the helper.
var ErrAgreementRequired = errors.New("helper model needs its risk notice accepted")

// ErrIncompatible reports an answer that is not the expected helper service or
// protocol version.
var ErrIncompatible = errors.New("helper answered with an unsupported service or protocol version")

type Model struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Info is the part of the info probe this server uses. An ASR helper lists
// its installed models; an LLM helper names the one translation model it runs
// and the language pairs that model supports.
type Info struct {
	Service    string  `json:"service"`
	APIVersion int     `json:"api_version"`
	Installed  bool    `json:"installed"`
	Model      string  `json:"model"`
	ModelName  string  `json:"model_name"`
	Models     []Model `json:"models"`
	Pairs      Pairs   `json:"pairs"`

	// AgreementRequired is set by an LLM helper whose selected model is used
	// only after its risk notice is accepted.
	AgreementRequired bool `json:"agreement_required"`
}

// Pairs are the source and target language codes of the directions an LLM
// helper's model translates. Nil, from "any" or an absent field, means any
// direction.
type Pairs [][2]string

func (p *Pairs) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	if bytes.Equal(data, []byte("null")) {
		*p = nil
		return nil
	}
	var keyword string
	if json.Unmarshal(data, &keyword) == nil {
		if keyword != "any" {
			return errors.New("invalid language pairs")
		}
		*p = nil
		return nil
	}
	var pairs [][2]string
	if err := json.Unmarshal(data, &pairs); err != nil {
		return err
	}
	*p = pairs
	return nil
}

// LanguageToken returns the language token of a helper language code, or
// empty for a code outside the languages the helper names. It accepts the
// helper's codes and the tokens this server sends.
func LanguageToken(code string) string {
	switch strings.ToLower(strings.TrimSpace(strings.ReplaceAll(code, "_", "-"))) {
	case "ja", "ja-jp":
		return "ja-jp"
	case "zh-cn", "zh-hans":
		return "zh-cn"
	case "zh-tw", "zh-hant":
		return "zh-tw"
	case "en", "en-us":
		return "en-us"
	case "ko", "ko-kr":
		return "ko-kr"
	}
	return ""
}

// DecodeInfo reads the info probe of service. A helper whose model is not
// installed yet is ErrNotInstalled, and one whose model waits for its risk
// notice to be accepted is ErrAgreementRequired.
func DecodeInfo(data []byte, service string) (Info, error) {
	var info Info
	if json.Unmarshal(data, &info) != nil || info.Service != service || info.APIVersion != APIVersion {
		return Info{}, ErrIncompatible
	}
	if !info.Installed {
		return Info{}, ErrNotInstalled
	}
	if info.AgreementRequired {
		return Info{}, ErrAgreementRequired
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
	// CodeAgreementRequired: the selected model is used only after its risk
	// notice is accepted in the helper.
	CodeAgreementRequired = "abliterated_agreement_required"
)

// ReasonOutOfMemory refines CodeStartFailed: the installed model ran out of
// video or system memory while loading.
const ReasonOutOfMemory = "out_of_memory"

// Failure codes of rejections that retrying unchanged cannot fix. The helper
// sends nothing to a model before it rejects a request this way.
const (
	// FailureNotReady: no model is installed, or not the requested one.
	FailureNotReady = "service_not_ready"
	// FailureStartFailed: the installed model could not start.
	FailureStartFailed = "service_start_failed"
	// FailureOutOfMemory: the installed model ran out of memory while loading.
	FailureOutOfMemory = "service_out_of_memory"
	// FailureUnsupportedLanguagePair: the model does not translate the direction.
	FailureUnsupportedLanguagePair = "unsupported_language_pair"
	// FailureAgreementRequired: the model's risk notice is not accepted in the
	// helper.
	FailureAgreementRequired = "service_agreement_required"
)

// Failure names a rejection the administrator resolves in the helper rather
// than by retrying unchanged, or returns empty for any other rejection. A
// start failure without a known reason, as from an older helper, is
// FailureStartFailed.
func Failure(rejection Rejection) string {
	switch rejection.Code {
	case CodeNotInstalled, CodeModelNotFound, CodeUnknownModel:
		return FailureNotReady
	case CodeStartFailed:
		if rejection.Reason == ReasonOutOfMemory {
			return FailureOutOfMemory
		}
		return FailureStartFailed
	case CodeUnsupportedLanguagePair:
		return FailureUnsupportedLanguagePair
	case CodeAgreementRequired:
		return FailureAgreementRequired
	}
	return ""
}

// Rejection is the code and optional reason of an OpenAI-style error body,
// {"error": {"code": "...", "reason": "..."}}. Both are empty when absent.
type Rejection struct {
	Code   string
	Reason string
}

// DecodeRejection reads the code and reason of an error body. A value that is
// too long to be a code is dropped.
func DecodeRejection(data []byte) Rejection {
	var body struct {
		Error struct {
			Code   string `json:"code"`
			Reason string `json:"reason"`
		} `json:"error"`
	}
	if json.Unmarshal(data, &body) != nil {
		return Rejection{}
	}
	value := func(text string) string {
		text = strings.TrimSpace(text)
		if len(text) > 64 {
			return ""
		}
		return text
	}
	return Rejection{Code: value(body.Error.Code), Reason: value(body.Error.Reason)}
}
