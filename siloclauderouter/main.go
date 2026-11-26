// Command siloclauderouter is a transparent, windowless binaryPath wrapper for Claude Agent SDK
// hosts (such as T3 Code's claudeAgent driver).
//
//   - Probes (--version, auth status, disableAllHooks capability checks), non-stream-json
//     invocations, non-Opus-5.5 models, fastMode, forked sessions, and Claude-routed sessions
//     pass straight through to real claude.
//   - When Silo's local dashboard advisor (http://127.0.0.1:8318/api/routing/claude) selects
//     Antigravity for a new claude-opus-5-5 session — or when resuming a previously AGY-routed
//     session — siloclauderouter bridges Claude Agent SDK stream-json stdio <-> native `agy acp`.
//   - Optionally passes `--cloud_code_endpoint` if `SILO_AGY_ENDPOINT` is configured.
//   - Fails safe to real claude if the advisor is unreachable or AGY ACP fails to initialize.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	defaultRouteURL       = "http://127.0.0.1:8318/api/routing/claude"
	defaultAgyEndpoint    = ""
	advisorRequestTimeout = 2 * time.Second
	agyStartupTimeout     = 20 * time.Second
	maxStoredSessions     = 500
)

type claudeInvocation struct {
	InputFormat       string
	OutputFormat      string
	Model             string
	Effort            string
	PermissionMode    string
	AllowDangerous    bool
	SessionID         string
	ResumeID          string
	ForkSession       bool
	AddDirs           []string
	MCPConfigs        []string
	FastMode          bool
	DisableAllHooks   bool
	IsProbe           bool
	HasNonFlagCommand bool
}

type routeDecision struct {
	Target     string   `json:"target"`
	AgyAccount *string  `json:"agy_account"`
	AgyOrder   []string `json:"agy_order"`
	Reason     string   `json:"reason"`
	Model      string   `json:"model"`
}

type sessionRecord struct {
	AgySessionID string `json:"agy_session_id"`
	AgyAccount   string `json:"agy_account"`
	Model        string `json:"model"`
	UpdatedAt    int64  `json:"updated_at"`
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	inv := parseClaudeArgs(args)

	home, _ := os.UserHomeDir()
	claudeBin := findClaudeBinary(home)
	if claudeBin == "" {
		fmt.Fprintln(stderr, "silo-claude-router: real claude binary not found (set SILO_CLAUDE_EXE)")
		return 1
	}

	// Fast path: non-stream-json, probes, fastMode, fork, or non-routable models go straight to claude.exe.
	if inv.IsProbe || inv.FastMode || inv.ForkSession {
		return execClaude(claudeBin, args, nil, stdin, stdout, stderr)
	}

	storePath := sessionStorePath(home)
	var resumeRec *sessionRecord
	var agyAccount string
	useAgy := false

	if inv.ResumeID != "" {
		if rec, ok := loadSessionRecord(storePath, inv.ResumeID); ok && rec.AgySessionID != "" {
			resumeRec = &rec
			agyAccount = rec.AgyAccount
			useAgy = true
		} else {
			return execClaude(claudeBin, args, nil, stdin, stdout, stderr)
		}
	} else {
		if !isAgyRoutableModel(inv.Model) {
			return execClaude(claudeBin, args, nil, stdin, stdout, stderr)
		}
		dec, err := queryRouteAdvisor(routeAdvisorURL(), inv.Model, true)
		if err != nil || !strings.EqualFold(dec.Target, "antigravity") {
			return execClaude(claudeBin, args, nil, stdin, stdout, stderr)
		}
		if dec.AgyAccount != nil {
			agyAccount = strings.TrimSpace(*dec.AgyAccount)
		}
		useAgy = true
	}

	if !useAgy {
		return execClaude(claudeBin, args, nil, stdin, stdout, stderr)
	}

	agyBin := findAgyBinary(home)
	geminiDir := findGeminiDir(home)
	if agyBin == "" || geminiDir == "" {
		return execClaude(claudeBin, args, nil, stdin, stdout, stderr)
	}

	// Buffer the first stdin line (normally control_request: initialize) so we can:
	// 1. Extract appendSystemPrompt before calling AGY session/new, and
	// 2. Replay the exact bytes into real claude.exe if AGY fails to start.
	bufReader := bufio.NewReaderSize(stdin, 1<<20)
	firstLine, readErr := bufReader.ReadBytes('\n')
	if readErr != nil && len(firstLine) == 0 {
		return 0
	}

	var initCtrl *sdkControlRequest
	if line := bytes.TrimSpace(firstLine); len(line) > 0 {
		var env sdkIncomingEnvelope
		if json.Unmarshal(line, &env) == nil && env.Type == "control_request" && env.Request.Subtype == "initialize" {
			initCtrl = &sdkControlRequest{
				RequestID: env.RequestID,
				Request:   env.Request,
			}
		}
	}

	endpoint := buildAgyEndpoint(agyAccount)
	cfg := bridgeConfig{
		AgyBinary:        agyBin,
		GeminiDir:        geminiDir,
		CloudCodeURL:     endpoint,
		AgyAccount:       agyAccount,
		Invocation:       inv,
		ResumeRecord:     resumeRec,
		SessionStorePath: storePath,
	}

	bridge, err := startAgyBridge(cfg, initCtrl)
	if err != nil {
		// Fail safe: replay buffered stdin to real claude.exe before emitting anything to stdout.
		fmt.Fprintf(stderr, "silo-claude-router: AGY ACP startup failed (%v); falling back to claude.exe\n", err)
		return execClaude(claudeBin, args, firstLine, bufReader, stdout, stderr)
	}
	defer bridge.Close()

	return bridge.Serve(firstLine, initCtrl, bufReader, stdout, stderr)
}

func routeAdvisorURL() string {
	if v := strings.TrimSpace(os.Getenv("SILO_ROUTE_URL")); v != "" {
		return v
	}
	return defaultRouteURL
}

func buildAgyEndpoint(agyAccount string) string {
	base := strings.TrimRight(strings.TrimSpace(os.Getenv("SILO_AGY_ENDPOINT")), "/")
	if base == "" {
		base = defaultAgyEndpoint
	}
	if base == "" {
		return ""
	}
	acct := strings.ToLower(strings.TrimSpace(agyAccount))
	if acct == "primary" || acct == "u1" {
		if !strings.HasSuffix(base, "/"+acct) {
			return base + "/" + acct
		}
	}
	return base
}

func isAgyRoutableModel(model string) bool {
	m := strings.ToLower(strings.TrimSpace(model))
	if idx := strings.LastIndexByte(m, '/'); idx >= 0 {
		m = m[idx+1:]
	}
	return m == "claude-opus-5-5"
}

func queryRouteAdvisor(baseURL, model string, claim bool) (routeDecision, error) {
	u, err := url.Parse(baseURL)
	if err != nil {
		return routeDecision{}, err
	}
	q := u.Query()
	if model != "" {
		q.Set("model", model)
	}
	if claim {
		q.Set("claim", "1")
	}
	u.RawQuery = q.Encode()

	ctx, cancel := context.WithTimeout(context.Background(), advisorRequestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return routeDecision{}, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return routeDecision{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return routeDecision{}, fmt.Errorf("advisor HTTP %d", resp.StatusCode)
	}
	var dec routeDecision
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&dec); err != nil {
		return routeDecision{}, err
	}
	return dec, nil
}

func parseClaudeArgs(args []string) claudeInvocation {
	var inv claudeInvocation
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--version" || a == "-v" || a == "--help" || a == "-h" {
			inv.IsProbe = true
			continue
		}
		if i == 0 && !strings.HasPrefix(a, "-") {
			inv.HasNonFlagCommand = true
			inv.IsProbe = true
			continue
		}
		key, val, hasEq := strings.Cut(a, "=")
		nextVal := func() string {
			if hasEq {
				return val
			}
			if i+1 < len(args) {
				i++
				return args[i]
			}
			return ""
		}
		switch key {
		case "--input-format":
			inv.InputFormat = strings.TrimSpace(nextVal())
		case "--output-format":
			inv.OutputFormat = strings.TrimSpace(nextVal())
		case "--model":
			inv.Model = strings.TrimSpace(nextVal())
		case "--effort":
			inv.Effort = strings.TrimSpace(nextVal())
		case "--permission-mode":
			inv.PermissionMode = strings.TrimSpace(nextVal())
		case "--allow-dangerously-skip-permissions", "--dangerously-skip-permissions":
			inv.AllowDangerous = true
		case "--session-id":
			inv.SessionID = strings.TrimSpace(nextVal())
		case "--resume", "-r":
			inv.ResumeID = strings.TrimSpace(nextVal())
		case "--fork-session":
			inv.ForkSession = true
		case "--add-dir":
			if d := strings.TrimSpace(nextVal()); d != "" {
				inv.AddDirs = append(inv.AddDirs, d)
			}
		case "--mcp-config":
			if mc := strings.TrimSpace(nextVal()); mc != "" {
				inv.MCPConfigs = append(inv.MCPConfigs, mc)
			}
		case "--settings":
			parseClaudeSettingsFlag(nextVal(), &inv)
		}
	}
	if inv.InputFormat != "stream-json" || inv.OutputFormat != "stream-json" || inv.DisableAllHooks {
		inv.IsProbe = true
	}
	return inv
}

func parseClaudeSettingsFlag(raw string, inv *claudeInvocation) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return
	}
	data := []byte(raw)
	if !strings.HasPrefix(raw, "{") {
		if b, err := os.ReadFile(raw); err == nil {
			data = b
		}
	}
	var obj map[string]any
	if json.Unmarshal(data, &obj) != nil {
		return
	}
	if v, ok := obj["fastMode"].(bool); ok && v {
		inv.FastMode = true
	}
	if v, ok := obj["disableAllHooks"].(bool); ok && v {
		inv.DisableAllHooks = true
	}
}

func sameExecutable(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	absA, errA := filepath.Abs(a)
	absB, errB := filepath.Abs(b)
	if errA != nil || errB != nil {
		return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
	}
	if realA, err := filepath.EvalSymlinks(absA); err == nil {
		absA = realA
	}
	if realB, err := filepath.EvalSymlinks(absB); err == nil {
		absB = realB
	}
	return strings.EqualFold(filepath.Clean(absA), filepath.Clean(absB))
}

func findClaudeBinary(home string) string {
	self, _ := os.Executable()
	if env := strings.TrimSpace(os.Getenv("SILO_CLAUDE_EXE")); env != "" {
		if st, err := os.Stat(env); err == nil && !st.IsDir() && !sameExecutable(self, env) {
			return env
		}
	}
	if home != "" {
		for _, rel := range []string{
			filepath.Join(".local", "bin", "claude.exe"),
			filepath.Join(".local", "bin", "claude"),
		} {
			cand := filepath.Join(home, rel)
			if st, err := os.Stat(cand); err == nil && !st.IsDir() && !sameExecutable(self, cand) {
				return cand
			}
		}
	}
	if p, err := exec.LookPath("claude"); err == nil && !sameExecutable(self, p) {
		return p
	}
	return ""
}

func findAgyBinary(home string) string {
	if env := strings.TrimSpace(os.Getenv("SILO_AGY_EXE")); env != "" {
		if st, err := os.Stat(env); err == nil && !st.IsDir() {
			return env
		}
	}
	if home != "" {
		versionsDir := filepath.Join(home, ".t3", "tools", "antigravity-acp", "win32-x64", "versions")
		if entries, err := os.ReadDir(versionsDir); err == nil {
			type cand struct {
				path string
				mod  time.Time
			}
			var cands []cand
			for _, e := range entries {
				if !e.IsDir() {
					continue
				}
				p := filepath.Join(versionsDir, e.Name(), "agy.exe")
				if st, err := os.Stat(p); err == nil && !st.IsDir() {
					cands = append(cands, cand{path: p, mod: st.ModTime()})
				}
			}
			sort.Slice(cands, func(i, j int) bool { return cands[i].mod.After(cands[j].mod) })
			if len(cands) > 0 {
				return cands[0].path
			}
		}
	}
	if p, err := exec.LookPath("agy"); err == nil {
		return p
	}
	return ""
}

func findGeminiDir(home string) string {
	if env := strings.TrimSpace(os.Getenv("SILO_AGY_GEMINI_DIR")); env != "" {
		if st, err := os.Stat(env); err == nil && st.IsDir() {
			return env
		}
	}
	if home == "" {
		return ""
	}
	root := filepath.Join(home, ".t3", "userdata", "providers", "antigravity")
	entries, err := os.ReadDir(root)
	if err != nil {
		return ""
	}
	var best string
	var bestMod time.Time
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(root, e.Name())
		tok := filepath.Join(dir, "antigravity-acp", "antigravity-oauth-token")
		if st, err := os.Stat(tok); err == nil && !st.IsDir() {
			if best == "" || st.ModTime().After(bestMod) {
				best = dir
				bestMod = st.ModTime()
			}
		}
	}
	return best
}

func sessionStorePath(home string) string {
	if env := strings.TrimSpace(os.Getenv("SILO_CLAUDE_ROUTER_SESSIONS")); env != "" {
		return env
	}
	if home == "" {
		return ""
	}
	return filepath.Join(home, ".silo-claude-router-sessions.json")
}

func loadSessionRecord(path, claudeSessionID string) (sessionRecord, bool) {
	if path == "" || claudeSessionID == "" {
		return sessionRecord{}, false
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return sessionRecord{}, false
	}
	var m map[string]sessionRecord
	if json.Unmarshal(raw, &m) != nil {
		return sessionRecord{}, false
	}
	rec, ok := m[claudeSessionID]
	return rec, ok
}

func saveSessionRecord(path, claudeSessionID string, rec sessionRecord) {
	if path == "" || claudeSessionID == "" || rec.AgySessionID == "" {
		return
	}
	m := make(map[string]sessionRecord)
	if raw, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(raw, &m)
	}
	rec.UpdatedAt = time.Now().Unix()
	m[claudeSessionID] = rec
	if len(m) > maxStoredSessions {
		type item struct {
			id string
			ts int64
		}
		items := make([]item, 0, len(m))
		for k, v := range m {
			items = append(items, item{id: k, ts: v.UpdatedAt})
		}
		sort.Slice(items, func(i, j int) bool { return items[i].ts < items[j].ts })
		for _, it := range items[:len(m)-maxStoredSessions] {
			delete(m, it.id)
		}
	}
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return
	}
	tmp := path + ".tmp." + randomHex(6)
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
	}
}

func execClaude(bin string, args []string, prefixStdin []byte, stdin io.Reader, stdout, stderr io.Writer) int {
	cmd := exec.Command(bin, args...)
	setNoWindow(cmd)
	if len(prefixStdin) > 0 {
		cmd.Stdin = io.MultiReader(bytes.NewReader(prefixStdin), stdin)
	} else {
		cmd.Stdin = stdin
	}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return exitErr.ExitCode()
		}
		fmt.Fprintf(stderr, "silo-claude-router: failed to launch %s: %v\n", bin, err)
		return 1
	}
	return 0
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func newUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
