package executor

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/MoeForge/moego/ojson"
	"github.com/gorilla/websocket"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor/helps"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	sdktranslator "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
)

func TestCodexExecutor_DefaultServiceTierHTTPAndPayloadBarrier(t *testing.T) {
	loc := time.FixedZone("CST", -6*3600)
	defer helps.SetCodexDefaultServiceTierNowFunc(func() time.Time {
		return time.Date(2026, 11, 24, 12, 0, 0, 0, loc)
	})()

	var mu sync.Mutex
	var capturedBodies [][]byte
	var capturedHints []string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		capturedBodies = append(capturedBodies, body)
		capturedHints = append(capturedHints, r.Header.Get(codexRoutingHintHeader))
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"gpt-5.5\",\"service_tier\":\"priority\",\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"ok\"}]}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n"))
	}))
	defer srv.Close()

	idlenetAuth := &cliproxyauth.Auth{
		ID:       "codex:apikey:c1",
		Provider: "codex",
		Attributes: map[string]string{
			"api_key":  "router-key",
			"base_url": srv.URL,
			cliproxyauth.AttributeCodexDefaultServiceTier:      "priority",
			cliproxyauth.AttributeCodexDefaultServiceTierUntil: "2026-12-31",
		},
	}
	personalAuth := &cliproxyauth.Auth{
		ID:       "codex-personal",
		Provider: "codex",
		Attributes: map[string]string{
			"base_url": srv.URL,
		},
		Metadata: map[string]any{
			"access_token": "personal-oauth-token",
		},
	}

	req := cliproxyexecutor.Request{
		Model:   "gpt-5.5",
		Payload: []byte(`{"model":"gpt-5.5","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}]}`),
	}
	opts := cliproxyexecutor.Options{SourceFormat: sdktranslator.FormatOpenAIResponse}

	exec := NewCodexExecutor(&config.Config{})
	if _, err := exec.Execute(context.Background(), idlenetAuth, req, opts); err != nil {
		t.Fatalf("Execute(idlenetAuth) error = %v", err)
	}
	if _, err := exec.Execute(context.Background(), personalAuth, req, opts); err != nil {
		t.Fatalf("Execute(personalAuth) error = %v", err)
	}
	streamRes, err := exec.ExecuteStream(context.Background(), idlenetAuth, req, opts)
	if err != nil {
		t.Fatalf("ExecuteStream(idlenetAuth) error = %v", err)
	}
	for range streamRes.Chunks {
	}

	// User payload filter rule remains the final barrier and can strip service_tier.
	filterExec := NewCodexExecutor(&config.Config{
		Payload: config.PayloadConfig{
			Filter: []config.PayloadFilterRule{{
				Models: []config.PayloadModelRule{{Name: "gpt-5.5", Protocol: "codex"}},
				Params: []string{"service_tier"},
			}},
		},
	})
	if _, err := filterExec.Execute(context.Background(), idlenetAuth, req, opts); err != nil {
		t.Fatalf("Execute(filterExec) error = %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(capturedBodies) != 4 {
		t.Fatalf("captured %d requests, want 4", len(capturedBodies))
	}
	if got := ojson.GetBytes(capturedBodies[0], "service_tier").String(); got != "priority" {
		t.Fatalf("idlenet Execute service_tier = %q, want priority", got)
	}
	if ojson.GetBytes(capturedBodies[1], "service_tier").Exists() {
		t.Fatalf("personal Execute unexpectedly set service_tier: %s", capturedBodies[1])
	}
	if capturedHints[1] != "model=gpt-5.5" {
		t.Fatalf("personal routing hint = %q, want model=gpt-5.5", capturedHints[1])
	}
	if got := ojson.GetBytes(capturedBodies[2], "service_tier").String(); got != "priority" {
		t.Fatalf("idlenet ExecuteStream service_tier = %q, want priority", got)
	}
	if ojson.GetBytes(capturedBodies[3], "service_tier").Exists() {
		t.Fatalf("payload filter rule failed to strip service_tier: %s", capturedBodies[3])
	}
}

func TestCodexWebsocketsExecutor_DefaultServiceTierAndExpiry(t *testing.T) {
	loc := time.FixedZone("CST", -6*3600)
	now := time.Date(2026, 12, 31, 23, 59, 0, 0, loc)
	defer helps.SetCodexDefaultServiceTierNowFunc(func() time.Time { return now })()

	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	var mu sync.Mutex
	var frames [][]byte

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return
		}
		mu.Lock()
		frames = append(frames, msg)
		mu.Unlock()
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"response.completed","response":{"id":"resp_ws","object":"response","status":"completed","model":"gpt-5.5","service_tier":"priority","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}`))
	}))
	defer srv.Close()

	auth := &cliproxyauth.Auth{
		ID:       "codex:apikey:c1-ws",
		Provider: "codex",
		Attributes: map[string]string{
			"api_key":    "router-key",
			"base_url":   srv.URL,
			"websockets": "true",
			cliproxyauth.AttributeCodexDefaultServiceTier:      "priority",
			cliproxyauth.AttributeCodexDefaultServiceTierUntil: "2026-12-31",
		},
	}
	req := cliproxyexecutor.Request{
		Model:   "gpt-5.5",
		Payload: []byte(`{"model":"gpt-5.5","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}]}`),
	}
	opts := cliproxyexecutor.Options{SourceFormat: sdktranslator.FormatOpenAIResponse}

	wsExec := NewCodexWebsocketsExecutor(&config.Config{})
	if _, err := wsExec.Execute(context.Background(), auth, req, opts); err != nil {
		t.Fatalf("ws Execute before expiry error = %v", err)
	}
	res, err := wsExec.ExecuteStream(cliproxyexecutor.WithDownstreamWebsocket(context.Background()), auth, req, opts)
	if err != nil {
		t.Fatalf("ws ExecuteStream before expiry error = %v", err)
	}
	for range res.Chunks {
	}

	// Advance past 2026-12-31 -> auto fast mode turns off automatically.
	now = time.Date(2027, 1, 1, 0, 0, 0, 0, loc)
	if _, err := wsExec.Execute(context.Background(), auth, req, opts); err != nil {
		t.Fatalf("ws Execute after expiry error = %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(frames) != 3 {
		t.Fatalf("captured %d ws frames, want 3", len(frames))
	}
	if got := strings.TrimSpace(ojson.GetBytes(frames[0], "service_tier").String()); got != "priority" {
		t.Fatalf("ws Execute before expiry service_tier = %q, want priority", got)
	}
	if got := strings.TrimSpace(ojson.GetBytes(frames[1], "service_tier").String()); got != "priority" {
		t.Fatalf("ws ExecuteStream before expiry service_tier = %q, want priority", got)
	}
	if ojson.GetBytes(frames[2], "service_tier").Exists() {
		t.Fatalf("ws Execute after expiry unexpectedly set service_tier: %s", frames[2])
	}
}

func TestCodexExecutor_OAuthDefaultServiceTier(t *testing.T) {
	var mu sync.Mutex
	var capturedBodies [][]byte
	var capturedHints []string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		capturedBodies = append(capturedBodies, body)
		capturedHints = append(capturedHints, r.Header.Get(codexRoutingHintHeader))
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_oauth\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"gpt-5.5\",\"service_tier\":\"priority\",\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"ok\"}]}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n"))
	}))
	defer srv.Close()

	teamOAuth := &cliproxyauth.Auth{
		ID:       "codex-team-1.json",
		Provider: "codex",
		Attributes: map[string]string{
			"base_url": srv.URL,
			cliproxyauth.AttributeCodexDefaultServiceTier: "priority",
		},
		Metadata: map[string]any{
			"access_token": "team-oauth-token",
			"account_id":   "team-acct-1",
			"plan_type":    "team",
		},
	}

	req := cliproxyexecutor.Request{
		Model:   "gpt-5.5",
		Payload: []byte(`{"model":"gpt-5.5","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}]}`),
	}
	opts := cliproxyexecutor.Options{SourceFormat: sdktranslator.FormatOpenAIResponse}

	exec := NewCodexExecutor(&config.Config{})
	if _, err := exec.Execute(context.Background(), teamOAuth, req, opts); err != nil {
		t.Fatalf("Execute(teamOAuth) error = %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(capturedBodies) != 1 {
		t.Fatalf("captured %d requests, want 1", len(capturedBodies))
	}
	if got := ojson.GetBytes(capturedBodies[0], "service_tier").String(); got != "priority" {
		t.Fatalf("teamOAuth Execute service_tier = %q, want priority", got)
	}
	if capturedHints[0] != "model=gpt-5.5;tier=priority" {
		t.Fatalf("teamOAuth routing hint = %q, want model=gpt-5.5;tier=priority", capturedHints[0])
	}
}
