package buildinfo

import "strings"

var Version = "v0.0.0-dev"

func UserAgent() string {
	return "Kikoto/" + strings.TrimPrefix(Version, "v")
}
