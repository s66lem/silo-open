package helps

import (
	"testing"
	"time"

	"github.com/MoeForge/moego/ojson"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

func TestApplyCodexDefaultServiceTierDoc(t *testing.T) {
	loc := time.FixedZone("CST", -6*3600)
	setClock := func(ts time.Time) func() {
		return SetCodexDefaultServiceTierNowFunc(func() time.Time { return ts })
	}

	t.Run("applies priority before inclusive date deadline", func(t *testing.T) {
		defer setClock(time.Date(2026, 12, 31, 23, 59, 59, 0, loc))()
		doc := ojson.NewDocString(`{"model":"gpt-5.5","input":"hi"}`)
		auth := &cliproxyauth.Auth{
			Provider: "codex",
			Attributes: map[string]string{
				cliproxyauth.AttributeCodexDefaultServiceTier:      "priority",
				cliproxyauth.AttributeCodexDefaultServiceTierUntil: "2026-12-31",
			},
		}
		if !ApplyCodexDefaultServiceTierDoc(doc, auth, "gpt-5.5") {
			t.Fatal("ApplyCodexDefaultServiceTierDoc() = false, want true")
		}
		if got := doc.Get("service_tier").String(); got != "priority" {
			t.Fatalf("service_tier = %q, want priority", got)
		}
	})

	t.Run("stops applying at midnight after inclusive date deadline", func(t *testing.T) {
		defer setClock(time.Date(2027, 1, 1, 0, 0, 0, 0, loc))()
		doc := ojson.NewDocString(`{"model":"gpt-5.5","input":"hi"}`)
		auth := &cliproxyauth.Auth{
			Provider: "codex",
			Attributes: map[string]string{
				cliproxyauth.AttributeCodexDefaultServiceTier:      "priority",
				cliproxyauth.AttributeCodexDefaultServiceTierUntil: "2026-12-31",
			},
		}
		if ApplyCodexDefaultServiceTierDoc(doc, auth, "gpt-5.5") {
			t.Fatal("ApplyCodexDefaultServiceTierDoc() = true after deadline, want false")
		}
		if doc.Get("service_tier").Exists() {
			t.Fatalf("service_tier unexpectedly set after deadline: %s", doc.String())
		}
	})

	t.Run("preserves explicit client tier", func(t *testing.T) {
		defer setClock(time.Date(2026, 11, 24, 12, 0, 0, 0, loc))()
		doc := ojson.NewDocString(`{"model":"gpt-5.5","service_tier":"ultrafast","input":"hi"}`)
		auth := &cliproxyauth.Auth{
			Provider: "codex",
			Attributes: map[string]string{
				cliproxyauth.AttributeCodexDefaultServiceTier: "priority",
			},
		}
		if ApplyCodexDefaultServiceTierDoc(doc, auth, "gpt-5.5") {
			t.Fatal("ApplyCodexDefaultServiceTierDoc() = true with explicit tier, want false")
		}
		if got := doc.Get("service_tier").String(); got != "ultrafast" {
			t.Fatalf("service_tier = %q, want ultrafast", got)
		}
	})

	t.Run("skips models known to not support priority", func(t *testing.T) {
		defer setClock(time.Date(2026, 11, 24, 12, 0, 0, 0, loc))()
		doc := ojson.NewDocString(`{"model":"gpt-6-chat-thinking","input":"hi"}`)
		auth := &cliproxyauth.Auth{
			Provider: "codex",
			Attributes: map[string]string{
				cliproxyauth.AttributeCodexDefaultServiceTier: "priority",
			},
		}
		if ApplyCodexDefaultServiceTierDoc(doc, auth, "gpt-6-chat-thinking") {
			t.Fatal("ApplyCodexDefaultServiceTierDoc() = true for unsupported model, want false")
		}
		if doc.Get("service_tier").Exists() {
			t.Fatalf("service_tier unexpectedly set on unsupported model: %s", doc.String())
		}
	})

	t.Run("does not apply to auth without default-service-tier", func(t *testing.T) {
		doc := ojson.NewDocString(`{"model":"gpt-5.5","input":"hi"}`)
		auth := &cliproxyauth.Auth{
			Provider: "codex",
			Metadata: map[string]any{"access_token": "oauth-tok"},
		}
		if ApplyCodexDefaultServiceTierDoc(doc, auth, "gpt-5.5") {
			t.Fatal("ApplyCodexDefaultServiceTierDoc() = true on personal auth, want false")
		}
		if doc.Get("service_tier").Exists() {
			t.Fatalf("service_tier unexpectedly set on personal auth: %s", doc.String())
		}
	})

	t.Run("fails closed on malformed until date", func(t *testing.T) {
		doc := ojson.NewDocString(`{"model":"gpt-5.5","input":"hi"}`)
		auth := &cliproxyauth.Auth{
			Provider: "codex",
			Attributes: map[string]string{
				cliproxyauth.AttributeCodexDefaultServiceTier:      "priority",
				cliproxyauth.AttributeCodexDefaultServiceTierUntil: "not-a-date",
			},
		}
		if ApplyCodexDefaultServiceTierDoc(doc, auth, "gpt-5.5") {
			t.Fatal("ApplyCodexDefaultServiceTierDoc() = true on invalid until, want false")
		}
	})
}
