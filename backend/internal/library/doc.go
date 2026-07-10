// Package library owns persisted work browsing: search-clause parsing, list
// queries, the common list projection, and batch enrichment reads.
//
// It deliberately does not merge metadata providers with file sources.
// Metadata snapshots describe works, while local, cache, and remote sources
// describe media presence and availability. The HTTP package remains
// responsible for authentication, request parsing, and response DTOs.
package library
