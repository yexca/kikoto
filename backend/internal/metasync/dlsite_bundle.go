package metasync

import (
	"context"
	"encoding/json"
	"regexp"
	"sort"
	"strings"

	"github.com/yexca/kikoto/backend/internal/dlsite"
)

// maxDeclaredBundleCodes bounds the codes read from one product's bundle
// fields, so a malformed payload cannot write an unbounded membership.
const maxDeclaredBundleCodes = 64

var bundleCodePattern = regexp.MustCompile(`(?i)^(?:RJ|BJ|VJ)[0-9]{6,8}$`)

// declaredBundleCodes returns the members a product declares in
// work_pack_children and the bundles that declare it in work_pack_parent. The
// fields' shape is not documented, so each entry may be a code, an object
// naming its code in workno or product_id, or an object keyed by code. Codes
// elsewhere in an entry, such as in an image path, do not count.
func declaredBundleCodes(raw json.RawMessage, code string) (members []string, bundles []string) {
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, nil
	}
	if nested, ok := payload["product"]; ok {
		return declaredBundleCodes(nested, code)
	}
	return bundleCodesIn(payload["work_pack_children"], code), bundleCodesIn(payload["work_pack_parent"], code)
}

func bundleCodesIn(field json.RawMessage, own string) []string {
	codes := []string{}
	seen := map[string]bool{strings.ToUpper(own): true}
	add := func(value string) {
		code := strings.ToUpper(strings.TrimSpace(value))
		if !bundleCodePattern.MatchString(code) || seen[code] || len(codes) >= maxDeclaredBundleCodes {
			return
		}
		seen[code] = true
		codes = append(codes, code)
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(field, &entries); err != nil {
		// An object keyed by code is one entry per key.
		var keyed map[string]json.RawMessage
		if err := json.Unmarshal(field, &keyed); err != nil {
			return codes
		}
		keys := make([]string, 0, len(keyed))
		for key := range keyed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			if bundleCodePattern.MatchString(strings.TrimSpace(key)) {
				add(key)
			} else {
				entries = append(entries, keyed[key])
			}
		}
	}
	for _, entry := range entries {
		var text string
		if err := json.Unmarshal(entry, &text); err == nil {
			add(text)
			continue
		}
		var object struct {
			WorkNo    string `json:"workno"`
			ProductID string `json:"product_id"`
		}
		if err := json.Unmarshal(entry, &object); err == nil {
			add(firstNonEmptyText(object.WorkNo, object.ProductID))
		}
	}
	return codes
}

// recordDeclaredBundles stores the bundle membership a product declares.
// Detection only adds rows: a member a user added or removed keeps that
// decision, and a member DLsite stops declaring stays until a user removes it.
func (s *DLsiteSyncer) recordDeclaredBundles(ctx context.Context, product dlsite.Product) error {
	code := dlsiteProductCode(product)
	if code == "" {
		return nil
	}
	raw := product.ProductRaw
	if len(raw) == 0 {
		raw = product.Raw
	}
	members, bundles := declaredBundleCodes(raw, code)
	for position, member := range members {
		if err := s.insertDetectedBundleMember(ctx, code, member, position); err != nil {
			return err
		}
	}
	for _, bundle := range bundles {
		if err := s.insertDetectedBundleMember(ctx, bundle, code, -1); err != nil {
			return err
		}
	}
	return nil
}

// insertDetectedBundleMember adds a detected member; a negative position puts
// it after the bundle's other members.
func (s *DLsiteSyncer) insertDetectedBundleMember(ctx context.Context, bundleCode string, memberCode string, position int) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO work_bundle_member (bundle_code, member_code, position, status, origin)
		VALUES (?, ?, CASE WHEN ? >= 0 THEN ?
			ELSE COALESCE((SELECT MAX(position) + 1 FROM work_bundle_member WHERE bundle_code = ?), 0) END,
			'linked', 'detected')
		ON CONFLICT(bundle_code, member_code) DO NOTHING
	`, bundleCode, memberCode, position, position, bundleCode)
	return err
}
