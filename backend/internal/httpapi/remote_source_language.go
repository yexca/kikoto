package httpapi

import (
	"context"
	"fmt"
	"strings"

	"github.com/yexca/kikoto/backend/internal/dlsite"
)

// A remote source is asked in the viewer's metadata languages first and in
// the source's configured fallback language last. An administrator sets the
// fallback per source because a source may not describe works in every
// language. Requests without a viewer, such as background jobs, use the
// instance default languages. The upstream may still ignore the hint.

type remoteSourceLanguage struct {
	// token is the presentation language, comparable with metadata language
	// tokens such as zh-cn.
	token string
	// tag is the Accept-Language tag sent upstream.
	tag string
}

func remoteSourceLanguageList(priorities []string, fallback string) []remoteSourceLanguage {
	result := []remoteSourceLanguage{}
	seen := map[string]bool{}
	add := func(token, tag string) {
		if token == "" || token == dlsite.OriginMetadataLanguage || seen[token] || tag == "" {
			return
		}
		seen[token] = true
		result = append(result, remoteSourceLanguage{token: token, tag: tag})
	}
	for _, language := range dlsite.NormalizeMetadataPriority(priorities) {
		add(language, metadataLanguageTag(language))
	}
	fallback = strings.TrimSpace(fallback)
	if fallback == "" {
		fallback = defaultRemoteRequestLanguage
	}
	add(normalizeRemotePresentationLanguage(fallback), fallback)
	return result
}

// metadataLanguageTag spells a metadata language token as a language tag,
// for example zh-cn as zh-CN.
func metadataLanguageTag(token string) string {
	language, region, found := strings.Cut(token, "-")
	if !found {
		return language
	}
	return language + "-" + strings.ToUpper(region)
}

// remoteSourceLanguages is the presentation priority for one source: the
// viewer's languages, then the source fallback.
func (s *Server) remoteSourceLanguages(ctx context.Context, source remoteSourceForUse) []string {
	return remoteSourceLanguageTokens(remoteSourceLanguageList(s.viewerMetadataLanguages(ctx), source.Config.RequestLanguage))
}

func remoteSourceLanguageTokens(languages []remoteSourceLanguage) []string {
	result := make([]string, 0, len(languages))
	for _, language := range languages {
		result = append(result, language.token)
	}
	return result
}

// remoteSourceAcceptLanguage is the Accept-Language value of a request to
// source on behalf of the request's viewer.
func (s *Server) remoteSourceAcceptLanguage(ctx context.Context, source remoteSourceForUse) string {
	return remoteAcceptLanguage(remoteSourceLanguageList(s.viewerMetadataLanguages(ctx), source.Config.RequestLanguage))
}

// instanceRemoteSourceAcceptLanguage is the Accept-Language value of a
// request whose result is stored for every user, independent of who caused it.
func (s *Server) instanceRemoteSourceAcceptLanguage(ctx context.Context, source remoteSourceForUse) string {
	return remoteAcceptLanguage(remoteSourceLanguageList(s.instanceMetadataLanguages(ctx), source.Config.RequestLanguage))
}

// remoteAcceptLanguage weights each language below the previous one, so the
// fallback is chosen only when the upstream has none of the preferred ones.
func remoteAcceptLanguage(languages []remoteSourceLanguage) string {
	parts := make([]string, 0, len(languages))
	for index, language := range languages {
		if index == 0 {
			parts = append(parts, language.tag)
			continue
		}
		weight := max(10-index, 1)
		parts = append(parts, fmt.Sprintf("%s;q=0.%d", language.tag, weight))
	}
	return strings.Join(parts, ", ")
}
