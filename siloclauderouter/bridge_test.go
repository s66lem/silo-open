package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseClaudeArgsAndGating(t *testing.T) {
	inv := parseClaudeArgs([]string{
		"--output-format", "stream-json",
		"--verbose",
		"--input-format=stream-json",
		"--effort=max",
		"--model=claude-opus-5-5",
		"--permission-mode=bypassPermissions",
		"--allow-dangerously-skip-permissions",
		"--add-dir=C:\\proj",
		"--session-id=sess-1",
		"--settings", `{"fastMode":false,"showThinkingSummaries":true}`,
	})
	if inv.IsProbe || inv.FastMode || inv.Model != "claude-opus-5-5" || inv.Effort != "max" || inv.SessionID != "sess-1" {
		t.Fatalf("unexpected parsed invocation: %+v", inv)
	}
	if mapEffortToThoughtLevel(inv.Effort) != "high" {
		t.Fatalf("expected effort=max -> high, got %q", mapEffortToThoughtLevel(inv.Effort))
	}

	// Fast mode disables AGY routing.
	fast := parseClaudeArgs([]string{
		"--input-format", "stream-json", "--output-format", "stream-json",
		"--model", "claude-opus-5-5", "--settings", `{"fastMode":true}`,
	})
	if !fast.FastMode {
		t.Fatal("expected fastMode=true to be detected")
	}

	// Capability probe (disableAllHooks) counts as probe -> passthrough to claude.exe.
	probe := parseClaudeArgs([]string{
		"--input-format", "stream-json", "--output-format", "stream-json",
		"--model", "claude-opus-5-5", "--settings", `{"disableAllHooks":true}`,
	})
	if !probe.IsProbe {
		t.Fatal("expected disableAllHooks to mark invocation as probe")
	}

	// Version / subcommand invocations count as probe.
	if !parseClaudeArgs([]string{"--version"}).IsProbe {
		t.Fatal("expected --version to be probe")
	}
	if !parseClaudeArgs([]string{"auth", "status"}).IsProbe {
		t.Fatal("expected auth status to be probe")
	}
}

func TestParseMCPConfigsConvertsHTTPHeadersToACP(t *testing.T) {
	raw := `{"mcpServers":{"t3-code":{"type":"http","url":"http://127.0.0.1:4567/mcp","headers":{"Authorization":"Bearer tok"}}}}`
	servers := parseMCPConfigs([]string{raw})
	if len(servers) != 1 {
		t.Fatalf("expected 1 MCP server, got %d", len(servers))
	}
	s := servers[0]
	if s.Type != "http" || s.Name != "t3-code" || s.URL != "http://127.0.0.1:4567/mcp" {
		t.Fatalf("unexpected server: %+v", s)
	}
	if len(s.Headers) != 1 || s.Headers[0].Name != "Authorization" || s.Headers[0].Value != "Bearer tok" {
		t.Fatalf("unexpected headers: %+v", s.Headers)
	}
}

func TestBuildAgyEndpoint(t *testing.T) {
	t.Setenv("SILO_AGY_ENDPOINT", "")
	if got := buildAgyEndpoint("primary"); got != "" {
		t.Fatalf("unset SILO_AGY_ENDPOINT should return empty string, got %q", got)
	}
	t.Setenv("SILO_AGY_ENDPOINT", "http://127.0.0.1:8321/agy-native")
	if got := buildAgyEndpoint("u1"); got != "http://127.0.0.1:8321/agy-native/u1" {
		t.Fatalf("u1 endpoint = %q", got)
	}
	if got := buildAgyEndpoint("primary"); got != "http://127.0.0.1:8321/agy-native/primary" {
		t.Fatalf("primary endpoint = %q", got)
	}
	if got := buildAgyEndpoint(""); got != "http://127.0.0.1:8321/agy-native" {
		t.Fatalf("empty endpoint = %q", got)
	}
}

func TestSessionStorePersistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sessions.json")
	saveSessionRecord(path, "claude-sess-1", sessionRecord{AgySessionID: "agy-sess-1", AgyAccount: "u1", Model: "claude-opus-5-5"})
	rec, ok := loadSessionRecord(path, "claude-sess-1")
	if !ok || rec.AgySessionID != "agy-sess-1" || rec.AgyAccount != "u1" {
		t.Fatalf("unexpected loaded record: ok=%v rec=%+v", ok, rec)
	}
}

// TestHelperProcess acts as either a fake `agy acp` server or a fake `claude` binary when
// invoked by Go tests with GO_WANT_HELPER_PROCESS set.
func TestHelperProcess(t *testing.T) {
	mode := os.Getenv("GO_WANT_HELPER_PROCESS")
	if mode == "" {
		return
	}
	defer os.Exit(0)

	switch mode {
	case "fake-claude":
		// Echo marker + all stdin lines so tests can verify passthrough and fallback replay.
		fmt.Println(`{"type":"fake_claude","args":` + mustJSON(os.Args[3:]) + `}`)
		sc := bufio.NewScanner(os.Stdin)
		for sc.Scan() {
			fmt.Println(`{"type":"fake_claude_stdin","line":` + mustJSON(sc.Text()) + `}`)
		}
	case "fake-agy-fail":
		fmt.Fprintln(os.Stderr, "simulated agy startup error")
		os.Exit(2)
	case "fake-agy":
		runFakeACPServer()
	}
}

func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func runFakeACPServer() {
	br := bufio.NewReader(os.Stdin)
	write := func(v any) {
		b, _ := json.Marshal(v)
		os.Stdout.Write(append(b, '\n'))
	}
	var seenModel, seenThought, seenMode string
	var seenMCP int
	for {
		line, err := br.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) == 0 {
			if err != nil {
				return
			}
			continue
		}
		var req acpMessage
		if json.Unmarshal(bytes.TrimSpace(line), &req) != nil {
			continue
		}
		switch req.Method {
		case "initialize":
			write(map[string]any{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result": map[string]any{
					"protocolVersion":   1,
					"agentCapabilities": map[string]any{"loadSession": true},
				},
			})
		case "session/new":
			var p struct {
				MCPServers []acpMCPServer `json:"mcpServers"`
			}
			_ = json.Unmarshal(req.Params, &p)
			seenMCP = len(p.MCPServers)
			write(map[string]any{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result":  map[string]any{"sessionId": "agy-test-sess-42"},
			})
		case "session/load":
			write(map[string]any{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result":  map[string]any{"sessionId": "agy-test-sess-42"},
			})
		case "session/set_config_option":
			var p struct {
				ConfigID string `json:"configId"`
				Value    string `json:"value"`
			}
			_ = json.Unmarshal(req.Params, &p)
			if p.ConfigID == "model" {
				seenModel = p.Value
			} else if p.ConfigID == "thought_level" {
				seenThought = p.Value
			}
			write(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}})
		case "session/set_mode":
			var p struct {
				ModeID string `json:"modeId"`
			}
			_ = json.Unmarshal(req.Params, &p)
			seenMode = p.ModeID
			write(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}})
		case "session/prompt":
			// Emit thinking, tool_call, tool_call_update, usage_update, and message chunks.
			write(map[string]any{
				"jsonrpc": "2.0",
				"method":  "session/update",
				"params": map[string]any{
					"sessionId": "agy-test-sess-42",
					"update": map[string]any{
						"sessionUpdate": "agent_thought_chunk",
						"content":       map[string]any{"type": "text", "text": "thinking..."},
					},
				},
			})
			write(map[string]any{
				"jsonrpc": "2.0",
				"method":  "session/update",
				"params": map[string]any{
					"sessionId": "agy-test-sess-42",
					"update": map[string]any{
						"sessionUpdate": "tool_call",
						"toolCallId":    "tc-1",
						"name":          "read_file",
						"rawInput":      map[string]any{"path": "README.md"},
					},
				},
			})
			write(map[string]any{
				"jsonrpc": "2.0",
				"method":  "session/update",
				"params": map[string]any{
					"sessionId": "agy-test-sess-42",
					"update": map[string]any{
						"sessionUpdate": "tool_call_update",
						"toolCallId":    "tc-1",
						"status":        "completed",
						"rawOutput":     "file contents",
					},
				},
			})
			write(map[string]any{
				"jsonrpc": "2.0",
				"method":  "session/update",
				"params": map[string]any{
					"sessionId": "agy-test-sess-42",
					"update": map[string]any{
						"sessionUpdate": "usage_update",
						"used":          1234,
					},
				},
			})
			write(map[string]any{
				"jsonrpc": "2.0",
				"method":  "session/update",
				"params": map[string]any{
					"sessionId": "agy-test-sess-42",
					"update": map[string]any{
						"sessionUpdate": "agent_message_chunk",
						"content":       map[string]any{"type": "text", "text": fmt.Sprintf("hello from agy (%s/%s/%s/mcp=%d)", seenModel, seenThought, seenMode, seenMCP)},
					},
				},
			})
			write(map[string]any{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result":  map[string]any{"stopReason": "end_turn"},
			})
		}
		if err != nil {
			return
		}
	}
}

func makeHelperWrapper(t *testing.T, mode string) string {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	// Windows .cmd wrapper or POSIX sh wrapper launching this test binary in TestHelperProcess mode.
	if os.PathSeparator == '\\' {
		p := filepath.Join(dir, mode+".cmd")
		body := fmt.Sprintf("@echo off\r\nset GO_WANT_HELPER_PROCESS=%s\r\n\"%s\" -test.run=^TestHelperProcess$ -- %%*\r\n", mode, exe)
		if err := os.WriteFile(p, []byte(body), 0o700); err != nil {
			t.Fatal(err)
		}
		return p
	}
	p := filepath.Join(dir, mode+".sh")
	body := fmt.Sprintf("#!/bin/sh\nGO_WANT_HELPER_PROCESS=%s exec \"%s\" -test.run='^TestHelperProcess$' -- \"$@\"\n", mode, exe)
	if err := os.WriteFile(p, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestBridgeEndToEndAndResume(t *testing.T) {
	advisor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"target":"antigravity","agy_account":"u1","agy_order":["u1","primary"],"reason":"agy_soonest_reset","model":"claude-opus-5-5"}`)
	}))
	defer advisor.Close()

	claudeHelper := makeHelperWrapper(t, "fake-claude")
	agyHelper := makeHelperWrapper(t, "fake-agy")
	geminiDir := t.TempDir()
	sessStore := filepath.Join(t.TempDir(), "sessions.json")

	t.Setenv("SILO_CLAUDE_EXE", claudeHelper)
	t.Setenv("SILO_AGY_EXE", agyHelper)
	t.Setenv("SILO_AGY_GEMINI_DIR", geminiDir)
	t.Setenv("SILO_ROUTE_URL", advisor.URL)
	t.Setenv("SILO_CLAUDE_ROUTER_SESSIONS", sessStore)

	stdin := strings.NewReader(
		`{"type":"control_request","request_id":"req-init","request":{"subtype":"initialize","appendSystemPrompt":"extra rule"}}` + "\n" +
			`{"type":"control_request","request_id":"req-mcp","request":{"subtype":"mcp_set_servers","servers":{"t3-code":{"type":"http","url":"http://127.0.0.1:9999/mcp","headers":{"Authorization":"Bearer x"}}}}}` + "\n" +
			`{"type":"user","message":{"role":"user","content":"say hi"},"uuid":"u-1"}` + "\n",
	)
	var stdout, stderr bytes.Buffer
	code := run([]string{
		"--output-format", "stream-json",
		"--input-format", "stream-json",
		"--model=claude-opus-5-5",
		"--effort=max",
		"--permission-mode=bypassPermissions",
		"--allow-dangerously-skip-permissions",
		"--session-id=claude-sess-99",
	}, stdin, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("run exit=%d stderr=%s stdout=%s", code, stderr.String(), stdout.String())
	}

	out := stdout.String()
	for _, want := range []string{
		`"request_id":"req-init"`,
		`"request_id":"req-mcp"`,
		`"errors":{}`,
		`"added":["t3-code"]`,
		`"subtype":"init"`,
		`"thinking_delta"`,
		`"type":"tool_use"`,
		`"type":"tool_result"`,
		`"hello from agy (claude-opus-5-5/high/auto/mcp=1)"`,
		`"type":"result"`,
		`"subtype":"success"`,
		`"user_message_uuid":"u-1"`,
		`"user_message_uuids":["u-1"]`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %s in bridged output:\n%s", want, out)
		}
	}

	// Verify session mapping was persisted for --resume.
	rec, ok := loadSessionRecord(sessStore, "claude-sess-99")
	if !ok || rec.AgySessionID != "agy-test-sess-42" || rec.AgyAccount != "u1" {
		t.Fatalf("expected persisted session mapping, got ok=%v rec=%+v", ok, rec)
	}
}

func TestStartupFailureFallsBackCleanlyToClaude(t *testing.T) {
	advisor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"target":"antigravity","agy_account":"primary","reason":"agy_window_unstarted","model":"claude-opus-5-5"}`)
	}))
	defer advisor.Close()

	claudeHelper := makeHelperWrapper(t, "fake-claude")
	agyFailHelper := makeHelperWrapper(t, "fake-agy-fail")
	t.Setenv("SILO_CLAUDE_EXE", claudeHelper)
	t.Setenv("SILO_AGY_EXE", agyFailHelper)
	t.Setenv("SILO_AGY_GEMINI_DIR", t.TempDir())
	t.Setenv("SILO_ROUTE_URL", advisor.URL)
	t.Setenv("SILO_CLAUDE_ROUTER_SESSIONS", filepath.Join(t.TempDir(), "sessions.json"))

	firstLine := `{"type":"control_request","request_id":"init-fb","request":{"subtype":"initialize"}}`
	var stdout, stderr bytes.Buffer
	code := run([]string{
		"--output-format", "stream-json",
		"--input-format", "stream-json",
		"--model=claude-opus-5-5",
	}, strings.NewReader(firstLine+"\n"), &stdout, &stderr)
	if code != 0 {
		t.Fatalf("fallback run exit=%d stderr=%s", code, stderr.String())
	}
	out := stdout.String()
	if !strings.Contains(out, `"type":"fake_claude"`) || !strings.Contains(out, `init-fb`) {
		t.Fatalf("expected fallback to fake-claude with replayed init line, got:\n%s", out)
	}
}
