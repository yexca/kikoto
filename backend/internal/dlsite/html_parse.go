package dlsite

import (
	"html"
	"regexp"
	"strconv"
	"strings"
)

var (
	titlePattern          = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
	workLinkPattern       = regexp.MustCompile(`(?is)<a\b[^>]*\bhref=["'][^"']*/work/=/product_id/((?:RJ|BJ|VJ)[0-9]{5,8})\.html[^"']*["'][^>]*>`)
	rankingWorkPattern    = regexp.MustCompile(`(?is)<(?:dl|li|div)\b[^>]*\bclass=["'][^"']*\bwork_1col\b[^"']*["'][^>]*>.*?<a\b[^>]*\bhref=["'][^"']*/work/=/product_id/((?:RJ|BJ|VJ)[0-9]{5,8})\.html[^"']*["']`)
	seriesLinkPattern     = regexp.MustCompile(`(?is)<a\b[^>]*\bhref=["']([^"']*/fsr/=/title_id/(SRI[0-9]+)/[^"']*)["'][^>]*>(.*?)</a>`)
	pageTotalPattern      = regexp.MustCompile(`(?is)class=["'][^"']*\bpage_total\b[^"']*["'][^>]*>(.*?)</div>`)
	numberTextPattern     = regexp.MustCompile(`[0-9][0-9,]*`)
	pagePathPattern       = regexp.MustCompile(`(?i)/page/([0-9]+)/maker_id/`)
	defaultMakerLanguages = []string{"JPN", "ENG", "CHI_HANS", "CHI_HANT", "KO_KR", "SPA", "GER", "FRE", "IND", "ITA", "POR", "SWE", "THA", "VIE", "OTL", "NM"}
)

func parseRankingWorkCodes(rawHTML string) []string {
	codes := make([]string, 0, 100)
	seen := map[string]bool{}
	for _, match := range rankingWorkPattern.FindAllStringSubmatch(rawHTML, -1) {
		if len(match) < 2 {
			continue
		}
		code := strings.ToUpper(strings.TrimSpace(match[1]))
		if code == "" || seen[code] {
			continue
		}
		seen[code] = true
		codes = append(codes, code)
	}
	return codes
}

func parseMakerName(rawHTML string) string {
	match := titlePattern.FindStringSubmatch(rawHTML)
	if len(match) < 2 {
		return ""
	}
	title := html.UnescapeString(stripTags(match[1]))
	for _, separator := range []string{"|", "｜", " - ", " / "} {
		if index := strings.Index(title, separator); index > 0 {
			title = title[:index]
		}
	}
	for _, suffix := range []string{"サークルプロフィール", "Circle Profile"} {
		title = strings.TrimSuffix(strings.TrimSpace(title), suffix)
	}
	title = strings.TrimSpace(strings.Join(strings.Fields(title), " "))
	return title
}

func parseWorkCodes(rawHTML string) []string {
	searchSpace := makerWorkListSearchSpace(rawHTML)
	matches := workLinkPattern.FindAllStringSubmatch(searchSpace, -1)
	seen := map[string]bool{}
	codes := []string{}
	for _, match := range matches {
		if len(match) < 2 {
			continue
		}
		code := strings.ToUpper(strings.TrimSpace(match[1]))
		if seen[code] {
			continue
		}
		seen[code] = true
		codes = append(codes, code)
	}
	return codes
}

func parseMakerSeries(rawHTML string, endpoints Endpoints) []MakerSeries {
	searchSpace := rawHTML
	if start := strings.Index(rawHTML, `class="prof_work_series"`); start >= 0 {
		searchSpace = rawHTML[start:]
		if end := strings.Index(searchSpace, `</td>`); end > 0 {
			searchSpace = searchSpace[:end]
		}
	}
	matches := seriesLinkPattern.FindAllStringSubmatch(searchSpace, -1)
	seen := map[string]bool{}
	series := []MakerSeries{}
	for _, match := range matches {
		if len(match) < 4 {
			continue
		}
		titleID := strings.ToUpper(strings.TrimSpace(match[2]))
		if titleID == "" || seen[titleID] {
			continue
		}
		seen[titleID] = true
		label := strings.TrimSpace(strings.Join(strings.Fields(html.UnescapeString(stripTags(match[3]))), " "))
		name := cleanSeriesName(label)
		series = append(series, MakerSeries{
			TitleID:   titleID,
			Name:      name,
			URL:       endpoints.ResolveURL(match[1]),
			WorkCount: parseSeriesWorkCount(label),
		})
	}
	return series
}

func cleanSeriesName(label string) string {
	name := strings.TrimSpace(label)
	if index := strings.LastIndex(name, "（"); index > 0 {
		name = strings.TrimSpace(name[:index])
	} else if index := strings.LastIndex(name, "("); index > 0 {
		name = strings.TrimSpace(name[:index])
	}
	name = strings.TrimSuffix(strings.TrimSpace(name), "シリーズ")
	name = strings.Trim(name, "「」\"'")
	return strings.TrimSpace(name)
}

func parseSeriesWorkCount(label string) int {
	matches := numberTextPattern.FindAllString(label, -1)
	if len(matches) == 0 {
		return 0
	}
	value, _ := strconv.Atoi(strings.ReplaceAll(matches[len(matches)-1], ",", ""))
	return value
}

func parsePageTotal(rawHTML string) int {
	match := pageTotalPattern.FindStringSubmatch(rawHTML)
	if len(match) < 2 {
		return 0
	}
	text := html.UnescapeString(stripTags(match[1]))
	value := strings.ReplaceAll(numberTextPattern.FindString(text), ",", "")
	if value == "" {
		return 0
	}
	total, _ := strconv.Atoi(value)
	return total
}

func parsePageNoMax(rawHTML string) int {
	maxPage := 0
	for _, match := range pagePathPattern.FindAllStringSubmatch(rawHTML, -1) {
		if len(match) < 2 {
			continue
		}
		page, _ := strconv.Atoi(match[1])
		if page > maxPage {
			maxPage = page
		}
	}
	return maxPage
}

func stripTags(value string) string {
	var builder strings.Builder
	inTag := false
	for _, char := range value {
		switch char {
		case '<':
			inTag = true
		case '>':
			inTag = false
		default:
			if !inTag {
				builder.WriteRune(char)
			}
		}
	}
	return builder.String()
}
