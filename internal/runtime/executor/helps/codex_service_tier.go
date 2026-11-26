package helps

import (
	"strings"
	"sync"
	"time"

	"github.com/MoeForge/moego/ojson"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

var (
	codexServiceTierClockMu  sync.RWMutex
	codexServiceTierClockNow = time.Now
)

// SetCodexDefaultServiceTierNowFunc overrides the clock used for credential
// default-service-tier deadline checks and returns a restore function.
func SetCodexDefaultServiceTierNowFunc(fn func() time.Time) func() {
	codexServiceTierClockMu.Lock()
	prev := codexServiceTierClockNow
	if fn == nil {
		codexServiceTierClockNow = time.Now
	} else {
		codexServiceTierClockNow = fn
	}
	codexServiceTierClockMu.Unlock()
	return func() {
		codexServiceTierClockMu.Lock()
		codexServiceTierClockNow = prev
		codexServiceTierClockMu.Unlock()
	}
}

func codexDefaultServiceTierNow() time.Time {
	codexServiceTierClockMu.RLock()
	fn := codexServiceTierClockNow
	codexServiceTierClockMu.RUnlock()
	return fn()
}

func normalizeCodexDefaultServiceTier(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "priority", "fast":
		return "priority"
	case "ultrafast":
		return "ultrafast"
	default:
		return ""
	}
}

func codexDefaultServiceTierActiveAt(until string, now time.Time) bool {
	until = strings.TrimSpace(until)
	if until == "" {
		return true
	}
	if len(until) == len("2006-01-02") {
		if day, err := time.ParseInLocation("2006-01-02", until, now.Location()); err == nil {
			return now.Before(day.AddDate(0, 0, 1))
		}
		return false
	}
	if deadline, err := time.Parse(time.RFC3339, until); err == nil {
		return now.Before(deadline)
	}
	return false
}

// ApplyCodexDefaultServiceTierDoc applies a credential's configured default
// Codex service_tier (for example "priority" for fast mode) when active,
// missing from the payload, and not explicitly unsupported by the target model.
// Call this before FinalizePayloadDoc so user payload rules remain final.
func ApplyCodexDefaultServiceTierDoc(doc *ojson.Doc, auth *cliproxyauth.Auth, model string) bool {
	if doc == nil || auth == nil || len(auth.Attributes) == 0 {
		return false
	}
	tier := normalizeCodexDefaultServiceTier(auth.Attributes[cliproxyauth.AttributeCodexDefaultServiceTier])
	if tier == "" {
		return false
	}
	if !codexDefaultServiceTierActiveAt(auth.Attributes[cliproxyauth.AttributeCodexDefaultServiceTierUntil], codexDefaultServiceTierNow()) {
		return false
	}
	if existing := doc.Get("service_tier"); existing.Type == ojson.String && strings.TrimSpace(existing.String()) != "" {
		return false
	}
	modelSlug := strings.TrimSpace(model)
	if modelSlug == "" {
		modelSlug = strings.TrimSpace(doc.Get("model").String())
	}
	if modelSlug != "" {
		if supported, known := registry.CodexClientModelSupportsServiceTier(modelSlug, tier); known && !supported {
			return false
		}
	}
	return doc.Set("service_tier", tier) == nil
}
