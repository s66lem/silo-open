package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type bridgeConfig struct {
	AgyBinary        string
	GeminiDir        string
	CloudCodeURL     string
	AgyAccount       string
	Invocation       claudeInvocation
	ResumeRecord     *sessionRecord
	SessionStorePath string
}

type sdkIncomingEnvelope struct {
	Type            string                `json:"type"`
	RequestID       string                `json:"request_id,omitempty"`
	Request         sdkControlReqPayload  `json:"request,omitempty"`
	Response        sdkControlRespPayload `json:"response,omitempty"`
	Message         json.RawMessage       `json:"message,omitempty"`
	UUID            string                `json:"uuid,omitempty"`
	ParentToolUseID *string               `json:"parent_tool_use_id,omitempty"`
}

type sdkControlRequest struct {
	RequestID string
	Request   sdkControlReqPayload
}

type sdkControlReqPayload struct {
	Subtype            string          `json:"subtype"`
	Model              string          `json:"model,omitempty"`
	Mode               string          `json:"mode,omitempty"`
	AppendSystemPrompt json.RawMessage `json:"appendSystemPrompt,omitempty"`
	Servers            json.RawMessage `json:"servers,omitempty"`
}

type sdkControlRespPayload struct {
	Subtype   string          `json:"subtype"`
	RequestID string          `json:"request_id"`
	Response  json.RawMessage `json:"response,omitempty"`
	Error     string          `json:"error,omitempty"`
}

type acpMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *acpError       `json:"error,omitempty"`
}

type acpError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *acpError) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("acp error %d: %s", e.Code, e.Message)
}

type acpMCPHeader struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type acpMCPEnv struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type acpMCPServer struct {
	Type    string         `json:"type"`
	Name    string         `json:"name"`
	URL     string         `json:"url,omitempty"`
	Headers []acpMCPHeader `json:"headers,omitempty"`
	Command string         `json:"command,omitempty"`
	Args    []string       `json:"args,omitempty"`
	Env     []acpMCPEnv    `json:"env,omitempty"`
}

type agyBridge struct {
	cfg             bridgeConfig
	cmd             *exec.Cmd
	acpStdin        io.WriteCloser
	acpWriteMu      sync.Mutex
	outMu           sync.Mutex
	stdout          io.Writer
	stderr          io.Writer
	claudeSessionID string
	agySessionID    string
	appendPrompt    string
	mcpServers      []acpMCPServer
	sessionMu       sync.Mutex
	cwd             string
	model           string
	permissionMode  string

	nextRPCID atomic.Int64
	pendingMu sync.Mutex
	pending   map[int64]chan acpMessage
	acpDone   chan struct{}
	acpErr    error

	permMu      sync.Mutex
	permWaiters map[string]chan sdkControlRespPayload

	turnMu   sync.Mutex
	stateMu  sync.Mutex
	active   *turnState
	turnWg   sync.WaitGroup
	closing  atomic.Bool
	closeOne sync.Once
}

type turnState struct {
	msgID         string
	userMsgUUID   string
	startedAt     time.Time
	nextBlockIdx  int
	openBlockType string
	openBlockIdx  int
	thinkingBuf   strings.Builder
	textBuf       strings.Builder
	usedTokens    int
	toolNames     map[string]string
	emittedTools  map[string]bool
	finishedTools map[string]bool
}

func startAgyBridge(cfg bridgeConfig, initCtrl *sdkControlRequest) (*agyBridge, error) {
	cwd, err := os.Getwd()
	if err != nil {
		cwd = "."
	}
	claudeSessionID := cfg.Invocation.SessionID
	if cfg.Invocation.ResumeID != "" {
		claudeSessionID = cfg.Invocation.ResumeID
	}
	if claudeSessionID == "" {
		claudeSessionID = newUUID()
	}
	model := cfg.Invocation.Model
	if model == "" {
		model = "claude-opus-5-5"
	}

	agyArgs := []string{
		"acp",
		"--gemini-dir", cfg.GeminiDir,
		"--app-data-dir", "antigravity-acp",
	}
	if cfg.CloudCodeURL != "" {
		agyArgs = append(agyArgs, "--cloud_code_endpoint", cfg.CloudCodeURL)
	}
	for _, d := range cfg.Invocation.AddDirs {
		agyArgs = append(agyArgs, "--add-dir", d)
	}
	if cfg.Invocation.AllowDangerous || cfg.Invocation.PermissionMode == "bypassPermissions" {
		agyArgs = append(agyArgs, "--dangerously-skip-permissions")
	}

	cmd := exec.Command(cfg.AgyBinary, agyArgs...)
	setNoWindow(cmd)
	acpIn, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("stdin pipe: %w", err)
	}
	acpOut, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}
	var stderrBuf bytes.Buffer
	cmd.Stderr = &stderrBuf

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start agy: %w", err)
	}

	b := &agyBridge{
		cfg:             cfg,
		cmd:             cmd,
		acpStdin:        acpIn,
		claudeSessionID: claudeSessionID,
		cwd:             cwd,
		model:           model,
		permissionMode:  cfg.Invocation.PermissionMode,
		pending:         make(map[int64]chan acpMessage),
		acpDone:         make(chan struct{}),
		permWaiters:     make(map[string]chan sdkControlRespPayload),
	}

	go b.readACPLoop(acpOut)

	ctx, cancel := context.WithTimeout(context.Background(), agyStartupTimeout)
	defer cancel()

	// 1. ACP initialize
	if _, err := b.callACP(ctx, "initialize", map[string]any{
		"protocolVersion": 1,
		"clientCapabilities": map[string]any{
			"fs":       map[string]any{"readTextFile": false, "writeTextFile": false},
			"terminal": false,
		},
		"clientInfo": map[string]any{"name": "silo-claude-router", "version": "1.0"},
	}); err != nil {
		b.Close()
		return nil, fmt.Errorf("acp initialize: %w (%s)", err, strings.TrimSpace(stderrBuf.String()))
	}

	mcpServers := parseMCPConfigs(cfg.Invocation.MCPConfigs)
	appendPrompt := extractAppendSystemPrompt(initCtrl)
	b.mcpServers = mcpServers
	b.appendPrompt = appendPrompt

	// When CLI already supplied MCP servers (or no dynamic mcp_set_servers is expected),
	// we still defer session/new until either mcp_set_servers arrives or the first user turn
	// so T3 Code's dynamic t3-code HTTP MCP server (sent via mcp_set_servers right after
	// initialize) is attached to the AGY ACP session.
	return b, nil
}

func (b *agyBridge) ensureSession(ctx context.Context) error {
	b.sessionMu.Lock()
	defer b.sessionMu.Unlock()
	if b.agySessionID != "" {
		return nil
	}

	mcpServers := b.mcpServers
	if mcpServers == nil {
		mcpServers = make([]acpMCPServer, 0)
	}

	var agySessionID string
	if b.cfg.ResumeRecord != nil && b.cfg.ResumeRecord.AgySessionID != "" {
		loadParams := map[string]any{
			"sessionId":  b.cfg.ResumeRecord.AgySessionID,
			"cwd":        b.cwd,
			"mcpServers": mcpServers,
		}
		if _, err := b.callACP(ctx, "session/load", loadParams); err == nil {
			agySessionID = b.cfg.ResumeRecord.AgySessionID
		}
	}
	if agySessionID == "" {
		newParams := map[string]any{
			"cwd":        b.cwd,
			"mcpServers": mcpServers,
		}
		if len(b.cfg.Invocation.AddDirs) > 0 {
			newParams["additionalDirectories"] = b.cfg.Invocation.AddDirs
		}
		if b.appendPrompt != "" {
			newParams["_meta"] = map[string]any{
				"antigravity": map[string]any{
					"systemPrompt": map[string]any{"append": b.appendPrompt},
				},
			}
		}
		resRaw, err := b.callACP(ctx, "session/new", newParams)
		if err != nil {
			return fmt.Errorf("acp session/new: %w", err)
		}
		var newRes struct {
			SessionID string `json:"sessionId"`
		}
		if err := json.Unmarshal(resRaw, &newRes); err != nil || newRes.SessionID == "" {
			return fmt.Errorf("acp session/new missing sessionId")
		}
		agySessionID = newRes.SessionID
	}

	thoughtLevel := mapEffortToThoughtLevel(b.cfg.Invocation.Effort)
	if _, err := b.callACP(ctx, "session/set_config_option", map[string]any{
		"sessionId": agySessionID,
		"configId":  "model",
		"value":     "claude-opus-5-5",
	}); err != nil {
		if _, err2 := b.callACP(ctx, "session/set_model", map[string]any{
			"sessionId": agySessionID,
			"modelId":   "claude-opus-5-5-" + thoughtLevel,
		}); err2 != nil {
			return fmt.Errorf("acp select claude-opus-5-5 failed: %w / %v", err, err2)
		}
	}
	_, _ = b.callACP(ctx, "session/set_config_option", map[string]any{
		"sessionId": agySessionID,
		"configId":  "thought_level",
		"value":     thoughtLevel,
	})
	if modeID := mapPermissionModeToAcpMode(b.permissionMode); modeID != "" {
		_, _ = b.callACP(ctx, "session/set_mode", map[string]any{
			"sessionId": agySessionID,
			"modeId":    modeID,
		})
	}

	b.agySessionID = agySessionID
	saveSessionRecord(b.cfg.SessionStorePath, b.claudeSessionID, sessionRecord{
		AgySessionID: agySessionID,
		AgyAccount:   b.cfg.AgyAccount,
		Model:        "claude-opus-5-5",
	})
	return nil
}

func (b *agyBridge) Close() {
	b.closeOne.Do(func() {
		b.closing.Store(true)
		if b.acpStdin != nil {
			_ = b.acpStdin.Close()
		}
		if b.cmd != nil && b.cmd.Process != nil {
			_ = b.cmd.Process.Kill()
			_ = b.cmd.Wait()
		}
	})
}

func (b *agyBridge) Serve(firstLine []byte, initCtrl *sdkControlRequest, r *bufio.Reader, stdout, stderr io.Writer) int {
	b.stdout = stdout
	b.stderr = stderr

	if initCtrl != nil {
		b.handleInitializeControl(initCtrl.RequestID)
	} else if len(bytes.TrimSpace(firstLine)) > 0 {
		b.dispatchSDKLine(firstLine)
	}

	for {
		line, err := r.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			b.dispatchSDKLine(line)
		}
		if err != nil {
			break
		}
	}

	b.turnWg.Wait()
	return 0
}

func (b *agyBridge) dispatchSDKLine(line []byte) {
	var env sdkIncomingEnvelope
	if err := json.Unmarshal(bytes.TrimSpace(line), &env); err != nil {
		return
	}
	switch env.Type {
	case "control_request":
		b.handleControlRequest(env.RequestID, env.Request)
	case "control_response":
		b.deliverPermissionResponse(env.Response)
	case "user":
		b.turnWg.Add(1)
		go func(msg json.RawMessage, uuid string) {
			defer b.turnWg.Done()
			b.handleUserTurn(msg, uuid)
		}(env.Message, env.UUID)
	}
}

func (b *agyBridge) handleInitializeControl(requestID string) {
	b.emitSDK(map[string]any{
		"type": "control_response",
		"response": map[string]any{
			"subtype":    "success",
			"request_id": requestID,
			"response": map[string]any{
				"commands":                []any{},
				"models":                  []any{},
				"account":                 map[string]any{},
				"output_style":            "default",
				"available_output_styles": []string{"default"},
			},
		},
	})
	permMode := b.permissionMode
	if permMode == "" {
		permMode = "default"
	}
	b.emitSDK(map[string]any{
		"type":           "system",
		"subtype":        "init",
		"cwd":            b.cwd,
		"session_id":     b.claudeSessionID,
		"tools":          []string{},
		"mcp_servers":    []any{},
		"model":          b.model,
		"permissionMode": permMode,
		"apiKeySource":   "none",
		"uuid":           newUUID(),
	})
}

func (b *agyBridge) handleControlRequest(requestID string, req sdkControlReqPayload) {
	respBody := map[string]any{}
	switch req.Subtype {
	case "initialize":
		b.handleInitializeControl(requestID)
		return
	case "mcp_set_servers":
		added := make([]string, 0)
		if len(req.Servers) > 0 {
			dynamic := parseMCPServerMap(req.Servers)
			b.sessionMu.Lock()
			existing := make(map[string]bool, len(b.mcpServers))
			for _, s := range b.mcpServers {
				existing[s.Name] = true
			}
			for _, s := range dynamic {
				if !existing[s.Name] {
					b.mcpServers = append(b.mcpServers, s)
					existing[s.Name] = true
				}
				added = append(added, s.Name)
			}
			b.sessionMu.Unlock()
		}
		// Start AGY session now with dynamic MCP servers attached.
		ctx, cancel := context.WithTimeout(context.Background(), agyStartupTimeout)
		sessErr := b.ensureSession(ctx)
		cancel()
		errMap := map[string]string{}
		if sessErr != nil && len(added) > 0 {
			// If session creation with MCP servers failed, retry without MCP servers so the
			// session still works even if AGY rejects a specific MCP config.
			b.sessionMu.Lock()
			b.mcpServers = make([]acpMCPServer, 0)
			b.sessionMu.Unlock()
			ctx2, cancel2 := context.WithTimeout(context.Background(), agyStartupTimeout)
			_ = b.ensureSession(ctx2)
			cancel2()
			for _, name := range added {
				errMap[name] = sessErr.Error()
			}
		}
		respBody = map[string]any{
			"added":   added,
			"removed": []string{},
			"errors":  errMap,
		}
	case "mcp_status":
		b.sessionMu.Lock()
		statuses := make([]map[string]any, 0, len(b.mcpServers))
		for _, s := range b.mcpServers {
			statuses = append(statuses, map[string]any{"name": s.Name, "status": "connected"})
		}
		b.sessionMu.Unlock()
		respBody = map[string]any{"mcpServers": statuses}
	case "cancel_async_message":
		respBody = map[string]any{"cancelled": false}
	case "list_permission_rules":
		respBody = map[string]any{"rules": []any{}}
	case "get_hooks_listing":
		respBody = map[string]any{"hooks": []any{}}
	case "interrupt":
		if b.agySessionID != "" {
			_ = b.notifyACP("session/cancel", map[string]any{"sessionId": b.agySessionID})
		}
		b.cancelPendingPermissions()
	case "set_model":
		if strings.TrimSpace(req.Model) != "" {
			b.model = strings.TrimSpace(req.Model)
			if b.agySessionID != "" {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				_, _ = b.callACP(ctx, "session/set_config_option", map[string]any{
					"sessionId": b.agySessionID,
					"configId":  "model",
					"value":     "claude-opus-5-5",
				})
				cancel()
			}
		}
	case "set_permission_mode":
		b.permissionMode = strings.TrimSpace(req.Mode)
		if modeID := mapPermissionModeToAcpMode(b.permissionMode); modeID != "" && b.agySessionID != "" {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_, _ = b.callACP(ctx, "session/set_mode", map[string]any{
				"sessionId": b.agySessionID,
				"modeId":    modeID,
			})
			cancel()
		}
	}
	b.emitSDK(map[string]any{
		"type": "control_response",
		"response": map[string]any{
			"subtype":    "success",
			"request_id": requestID,
			"response":   respBody,
		},
	})
}

func (b *agyBridge) handleUserTurn(rawMsg json.RawMessage, userUUID string) {
	b.turnMu.Lock()
	defer b.turnMu.Unlock()

	if err := b.ensureSession(context.Background()); err != nil {
		resFrame := map[string]any{
			"type":        "result",
			"subtype":     "error_during_execution",
			"is_error":    true,
			"duration_ms": 0,
			"num_turns":   0,
			"result":      "",
			"errors":      []string{err.Error()},
			"session_id":  b.claudeSessionID,
			"uuid":        newUUID(),
		}
		if userUUID != "" {
			resFrame["user_message_uuid"] = userUUID
			resFrame["user_message_uuids"] = []string{userUUID}
		}
		b.emitSDK(resFrame)
		return
	}

	blocks := convertClaudeUserMessageToACPPrompt(rawMsg)
	if len(blocks) == 0 {
		blocks = []map[string]any{{"type": "text", "text": ""}}
	}

	ts := &turnState{
		msgID:         "msg_" + randomHex(12),
		userMsgUUID:   userUUID,
		startedAt:     time.Now(),
		openBlockIdx:  -1,
		toolNames:     make(map[string]string),
		emittedTools:  make(map[string]bool),
		finishedTools: make(map[string]bool),
	}
	b.stateMu.Lock()
	b.active = ts
	b.stateMu.Unlock()

	// Start message stream for T3 Code's claudeAgent adapter.
	b.emitSDK(map[string]any{
		"type": "stream_event",
		"event": map[string]any{
			"type": "message_start",
			"message": map[string]any{
				"id":            ts.msgID,
				"type":          "message",
				"role":          "assistant",
				"model":         b.model,
				"content":       []any{},
				"stop_reason":   nil,
				"stop_sequence": nil,
				"usage":         map[string]any{"input_tokens": 0, "output_tokens": 0},
			},
		},
		"session_id":         b.claudeSessionID,
		"parent_tool_use_id": nil,
		"uuid":               newUUID(),
	})

	_, promptErr := b.callACP(context.Background(), "session/prompt", map[string]any{
		"sessionId": b.agySessionID,
		"prompt":    blocks,
	})

	b.stateMu.Lock()
	b.closeOpenBlockLocked(ts)
	finalText := ts.textBuf.String()
	finalThinking := ts.thinkingBuf.String()
	usedTokens := ts.usedTokens
	b.active = nil
	b.stateMu.Unlock()

	b.emitSDK(map[string]any{
		"type": "stream_event",
		"event": map[string]any{
			"type": "message_stop",
		},
		"session_id":         b.claudeSessionID,
		"parent_tool_use_id": nil,
		"uuid":               newUUID(),
	})

	var content []map[string]any
	if finalThinking != "" {
		content = append(content, map[string]any{"type": "thinking", "thinking": finalThinking})
	}
	if finalText != "" {
		content = append(content, map[string]any{"type": "text", "text": finalText})
	}
	if len(content) > 0 {
		b.emitSDK(map[string]any{
			"type": "assistant",
			"message": map[string]any{
				"id":            ts.msgID,
				"type":          "message",
				"role":          "assistant",
				"model":         b.model,
				"content":       content,
				"stop_reason":   "end_turn",
				"stop_sequence": nil,
				"usage":         map[string]any{"input_tokens": usedTokens, "output_tokens": 0},
			},
			"session_id":         b.claudeSessionID,
			"parent_tool_use_id": nil,
			"uuid":               newUUID(),
		})
	}

	durationMS := time.Since(ts.startedAt).Milliseconds()
	resFrame := map[string]any{
		"type":        "result",
		"subtype":     "success",
		"is_error":    false,
		"duration_ms": durationMS,
		"num_turns":   1,
		"result":      finalText,
		"session_id":  b.claudeSessionID,
		"uuid":        newUUID(),
	}
	if userUUID != "" {
		resFrame["user_message_uuid"] = userUUID
		resFrame["user_message_uuids"] = []string{userUUID}
	}
	if promptErr != nil {
		resFrame["subtype"] = "error_during_execution"
		resFrame["is_error"] = true
		resFrame["errors"] = []string{promptErr.Error()}
	}
	b.emitSDK(resFrame)
}

func (b *agyBridge) closeOpenBlockLocked(ts *turnState) {
	if ts == nil || ts.openBlockIdx < 0 {
		return
	}
	idx := ts.openBlockIdx
	ts.openBlockIdx = -1
	ts.openBlockType = ""
	b.emitSDK(map[string]any{
		"type": "stream_event",
		"event": map[string]any{
			"type":  "content_block_stop",
			"index": idx,
		},
		"session_id":         b.claudeSessionID,
		"parent_tool_use_id": nil,
		"uuid":               newUUID(),
	})
}

func (b *agyBridge) handleACPNotification(method string, params json.RawMessage) {
	if method != "session/update" {
		return
	}
	var payload struct {
		SessionID string `json:"sessionId"`
		Update    struct {
			SessionUpdate string          `json:"sessionUpdate"`
			Content       json.RawMessage `json:"content"`
			ToolCallID    string          `json:"toolCallId"`
			Name          string          `json:"name"`
			Title         string          `json:"title"`
			Kind          string          `json:"kind"`
			Status        string          `json:"status"`
			RawInput      json.RawMessage `json:"rawInput"`
			RawOutput     json.RawMessage `json:"rawOutput"`
			Used          int             `json:"used"`
		} `json:"update"`
	}
	if json.Unmarshal(params, &payload) != nil {
		return
	}
	u := payload.Update

	b.stateMu.Lock()
	ts := b.active
	if ts == nil {
		b.stateMu.Unlock()
		return
	}

	switch u.SessionUpdate {
	case "agent_thought_chunk":
		chunk := extractACPContentText(u.Content)
		if chunk == "" {
			b.stateMu.Unlock()
			return
		}
		if ts.openBlockType != "thinking" {
			b.closeOpenBlockLocked(ts)
			ts.openBlockIdx = ts.nextBlockIdx
			ts.nextBlockIdx++
			ts.openBlockType = "thinking"
			b.emitSDK(map[string]any{
				"type": "stream_event",
				"event": map[string]any{
					"type":          "content_block_start",
					"index":         ts.openBlockIdx,
					"content_block": map[string]any{"type": "thinking", "thinking": ""},
				},
				"session_id":         b.claudeSessionID,
				"parent_tool_use_id": nil,
				"uuid":               newUUID(),
			})
		}
		ts.thinkingBuf.WriteString(chunk)
		b.emitSDK(map[string]any{
			"type": "stream_event",
			"event": map[string]any{
				"type":  "content_block_delta",
				"index": ts.openBlockIdx,
				"delta": map[string]any{"type": "thinking_delta", "thinking": chunk},
			},
			"session_id":         b.claudeSessionID,
			"parent_tool_use_id": nil,
			"uuid":               newUUID(),
		})

	case "agent_message_chunk":
		chunk := extractACPContentText(u.Content)
		if chunk == "" {
			b.stateMu.Unlock()
			return
		}
		if ts.openBlockType != "text" {
			b.closeOpenBlockLocked(ts)
			ts.openBlockIdx = ts.nextBlockIdx
			ts.nextBlockIdx++
			ts.openBlockType = "text"
			b.emitSDK(map[string]any{
				"type": "stream_event",
				"event": map[string]any{
					"type":          "content_block_start",
					"index":         ts.openBlockIdx,
					"content_block": map[string]any{"type": "text", "text": ""},
				},
				"session_id":         b.claudeSessionID,
				"parent_tool_use_id": nil,
				"uuid":               newUUID(),
			})
		}
		ts.textBuf.WriteString(chunk)
		b.emitSDK(map[string]any{
			"type": "stream_event",
			"event": map[string]any{
				"type":  "content_block_delta",
				"index": ts.openBlockIdx,
				"delta": map[string]any{"type": "text_delta", "text": chunk},
			},
			"session_id":         b.claudeSessionID,
			"parent_tool_use_id": nil,
			"uuid":               newUUID(),
		})

	case "tool_call":
		b.closeOpenBlockLocked(ts)
		tid := u.ToolCallID
		if tid == "" {
			tid = "toolu_" + randomHex(8)
		}
		name := firstNonEmpty(u.Name, u.Title, u.Kind, "tool")
		ts.toolNames[tid] = name
		if !ts.emittedTools[tid] {
			ts.emittedTools[tid] = true
			inputObj := decodeJSONOrWrap(u.RawInput)
			b.emitSDK(map[string]any{
				"type": "assistant",
				"message": map[string]any{
					"id":    "msg_" + randomHex(10),
					"type":  "message",
					"role":  "assistant",
					"model": b.model,
					"content": []map[string]any{{
						"type":  "tool_use",
						"id":    tid,
						"name":  name,
						"input": inputObj,
					}},
					"stop_reason":   "tool_use",
					"stop_sequence": nil,
					"usage":         map[string]any{"input_tokens": 0, "output_tokens": 0},
				},
				"session_id":         b.claudeSessionID,
				"parent_tool_use_id": nil,
				"uuid":               newUUID(),
			})
		}

	case "tool_call_update":
		tid := u.ToolCallID
		if tid != "" && (u.Status == "completed" || u.Status == "failed") && !ts.finishedTools[tid] {
			ts.finishedTools[tid] = true
			if !ts.emittedTools[tid] {
				ts.emittedTools[tid] = true
				name := firstNonEmpty(u.Name, u.Title, ts.toolNames[tid], u.Kind, "tool")
				b.emitSDK(map[string]any{
					"type": "assistant",
					"message": map[string]any{
						"id":    "msg_" + randomHex(10),
						"type":  "message",
						"role":  "assistant",
						"model": b.model,
						"content": []map[string]any{{
							"type":  "tool_use",
							"id":    tid,
							"name":  name,
							"input": decodeJSONOrWrap(u.RawInput),
						}},
						"stop_reason":   "tool_use",
						"stop_sequence": nil,
						"usage":         map[string]any{"input_tokens": 0, "output_tokens": 0},
					},
					"session_id":         b.claudeSessionID,
					"parent_tool_use_id": nil,
					"uuid":               newUUID(),
				})
			}
			outText := extractACPOutputText(u.RawOutput, u.Content)
			b.emitSDK(map[string]any{
				"type": "user",
				"message": map[string]any{
					"role": "user",
					"content": []map[string]any{{
						"type":        "tool_result",
						"tool_use_id": tid,
						"content":     outText,
						"is_error":    u.Status == "failed",
					}},
				},
				"session_id":         b.claudeSessionID,
				"parent_tool_use_id": nil,
				"uuid":               newUUID(),
			})
		}

	case "usage_update":
		if u.Used > 0 {
			ts.usedTokens = u.Used
			b.emitSDK(map[string]any{
				"type": "stream_event",
				"event": map[string]any{
					"type":  "message_delta",
					"delta": map[string]any{},
					"usage": map[string]any{"input_tokens": u.Used},
				},
				"session_id":         b.claudeSessionID,
				"parent_tool_use_id": nil,
				"uuid":               newUUID(),
			})
		}
	}
	b.stateMu.Unlock()
}

func (b *agyBridge) handleACPRequest(id json.RawMessage, method string, params json.RawMessage) {
	if method != "session/request_permission" {
		_ = b.writeACPRaw(map[string]any{
			"jsonrpc": "2.0",
			"id":      id,
			"error":   map[string]any{"code": -32601, "message": "method not supported"},
		})
		return
	}
	var req struct {
		ToolCall struct {
			ToolCallID string          `json:"toolCallId"`
			Title      string          `json:"title"`
			Name       string          `json:"name"`
			RawInput   json.RawMessage `json:"rawInput"`
		} `json:"toolCall"`
		Options []struct {
			OptionID string `json:"optionId"`
			Kind     string `json:"kind"`
			Name     string `json:"name"`
		} `json:"options"`
	}
	_ = json.Unmarshal(params, &req)

	allowID := ""
	rejectID := ""
	for _, opt := range req.Options {
		k := strings.ToLower(opt.Kind)
		if allowID == "" && (k == "allow_once" || k == "allow_always" || strings.Contains(k, "allow")) {
			allowID = opt.OptionID
		}
		if rejectID == "" && (k == "reject_once" || k == "reject_always" || strings.Contains(k, "reject")) {
			rejectID = opt.OptionID
		}
	}
	if allowID == "" && len(req.Options) > 0 {
		allowID = req.Options[0].OptionID
	}

	// Auto-approve when running in bypassPermissions / full-access mode.
	if b.cfg.Invocation.AllowDangerous || b.permissionMode == "bypassPermissions" || b.stdout == nil {
		outcome := map[string]any{"outcome": "cancelled"}
		if allowID != "" {
			outcome = map[string]any{"outcome": "selected", "optionId": allowID}
		}
		_ = b.writeACPRaw(map[string]any{
			"jsonrpc": "2.0",
			"id":      id,
			"result":  map[string]any{"outcome": outcome},
		})
		return
	}

	// Otherwise ask Claude Agent SDK via control_request: can_use_tool.
	ctrlID := "perm_" + randomHex(8)
	ch := make(chan sdkControlRespPayload, 1)
	b.permMu.Lock()
	b.permWaiters[ctrlID] = ch
	b.permMu.Unlock()

	toolName := firstNonEmpty(req.ToolCall.Name, req.ToolCall.Title, "tool")
	b.emitSDK(map[string]any{
		"type":       "control_request",
		"request_id": ctrlID,
		"request": map[string]any{
			"subtype":     "can_use_tool",
			"tool_name":   toolName,
			"input":       decodeJSONOrWrap(req.ToolCall.RawInput),
			"tool_use_id": req.ToolCall.ToolCallID,
		},
	})

	var resp sdkControlRespPayload
	var ok bool
	select {
	case resp, ok = <-ch:
	case <-b.acpDone:
	}

	b.permMu.Lock()
	delete(b.permWaiters, ctrlID)
	b.permMu.Unlock()

	allowed := false
	if ok && resp.Subtype == "success" {
		var body struct {
			Behavior string `json:"behavior"`
		}
		if json.Unmarshal(resp.Response, &body) == nil && body.Behavior == "allow" {
			allowed = true
		}
	}
	outcome := map[string]any{"outcome": "cancelled"}
	if allowed && allowID != "" {
		outcome = map[string]any{"outcome": "selected", "optionId": allowID}
	} else if !allowed && rejectID != "" {
		outcome = map[string]any{"outcome": "selected", "optionId": rejectID}
	}
	_ = b.writeACPRaw(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"result":  map[string]any{"outcome": outcome},
	})
}

func (b *agyBridge) deliverPermissionResponse(resp sdkControlRespPayload) {
	b.permMu.Lock()
	ch, ok := b.permWaiters[resp.RequestID]
	b.permMu.Unlock()
	if ok {
		select {
		case ch <- resp:
		default:
		}
	}
}

func (b *agyBridge) cancelPendingPermissions() {
	b.permMu.Lock()
	for id, ch := range b.permWaiters {
		delete(b.permWaiters, id)
		close(ch)
	}
	b.permMu.Unlock()
}

func (b *agyBridge) readACPLoop(r io.Reader) {
	defer close(b.acpDone)
	br := bufio.NewReaderSize(r, 1<<20)
	for {
		line, err := br.ReadBytes('\n')
		if trimmed := bytes.TrimSpace(line); len(trimmed) > 0 {
			var msg acpMessage
			if json.Unmarshal(trimmed, &msg) == nil {
				if msg.Method != "" && len(msg.ID) == 0 {
					b.handleACPNotification(msg.Method, msg.Params)
				} else if msg.Method != "" && len(msg.ID) > 0 {
					go b.handleACPRequest(msg.ID, msg.Method, msg.Params)
				} else if len(msg.ID) > 0 {
					var numID int64
					if json.Unmarshal(msg.ID, &numID) == nil {
						b.pendingMu.Lock()
						ch, ok := b.pending[numID]
						if ok {
							delete(b.pending, numID)
						}
						b.pendingMu.Unlock()
						if ok {
							ch <- msg
						}
					}
				}
			}
		}
		if err != nil {
			b.acpErr = err
			b.pendingMu.Lock()
			for id, ch := range b.pending {
				delete(b.pending, id)
				close(ch)
			}
			b.pendingMu.Unlock()
			return
		}
	}
}

func (b *agyBridge) writeACPRaw(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	b.acpWriteMu.Lock()
	defer b.acpWriteMu.Unlock()
	_, err = b.acpStdin.Write(data)
	return err
}

func (b *agyBridge) notifyACP(method string, params any) error {
	return b.writeACPRaw(map[string]any{
		"jsonrpc": "2.0",
		"method":  method,
		"params":  params,
	})
}

func (b *agyBridge) callACP(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id := b.nextRPCID.Add(1)
	ch := make(chan acpMessage, 1)
	b.pendingMu.Lock()
	b.pending[id] = ch
	b.pendingMu.Unlock()

	if err := b.writeACPRaw(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
		"params":  params,
	}); err != nil {
		b.pendingMu.Lock()
		delete(b.pending, id)
		b.pendingMu.Unlock()
		return nil, err
	}

	select {
	case msg, ok := <-ch:
		if !ok {
			return nil, fmt.Errorf("acp process closed during %s", method)
		}
		if msg.Error != nil {
			return nil, msg.Error
		}
		return msg.Result, nil
	case <-ctx.Done():
		b.pendingMu.Lock()
		delete(b.pending, id)
		b.pendingMu.Unlock()
		return nil, ctx.Err()
	}
}

func (b *agyBridge) emitSDK(v any) {
	if b.stdout == nil {
		return
	}
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	data = append(data, '\n')
	b.outMu.Lock()
	_, _ = b.stdout.Write(data)
	b.outMu.Unlock()
}

func mapEffortToThoughtLevel(effort string) string {
	switch strings.ToLower(strings.TrimSpace(effort)) {
	case "low":
		return "low"
	case "medium":
		return "medium"
	case "high", "xhigh", "max", "ultrathink":
		return "high"
	default:
		return "medium"
	}
}

func mapPermissionModeToAcpMode(mode string) string {
	switch strings.TrimSpace(mode) {
	case "bypassPermissions", "dontAsk":
		return "auto"
	case "plan":
		return "plan"
	case "acceptEdits":
		return "accept-edits"
	case "default":
		return "default"
	default:
		return ""
	}
}

func extractAppendSystemPrompt(initCtrl *sdkControlRequest) string {
	if initCtrl == nil || len(initCtrl.Request.AppendSystemPrompt) == 0 {
		return ""
	}
	var single string
	if json.Unmarshal(initCtrl.Request.AppendSystemPrompt, &single) == nil {
		return strings.TrimSpace(single)
	}
	var list []string
	if json.Unmarshal(initCtrl.Request.AppendSystemPrompt, &list) == nil {
		return strings.TrimSpace(strings.Join(list, "\n\n"))
	}
	return ""
}

func parseMCPServerMap(raw json.RawMessage) []acpMCPServer {
	out := make([]acpMCPServer, 0)
	if len(bytes.TrimSpace(raw)) == 0 {
		return out
	}
	var servers map[string]struct {
		Type    string            `json:"type"`
		URL     string            `json:"url"`
		Headers map[string]string `json:"headers"`
		Command string            `json:"command"`
		Args    []string          `json:"args"`
		Env     map[string]string `json:"env"`
	}
	if json.Unmarshal(raw, &servers) != nil {
		return out
	}
	names := make([]string, 0, len(servers))
	for name := range servers {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		srv := servers[name]
		kind := strings.ToLower(strings.TrimSpace(srv.Type))
		if kind == "" && srv.URL != "" {
			kind = "http"
		} else if kind == "" && srv.Command != "" {
			kind = "stdio"
		}
		switch kind {
		case "http", "sse":
			if srv.URL == "" {
				continue
			}
			var headers []acpMCPHeader
			hKeys := make([]string, 0, len(srv.Headers))
			for k := range srv.Headers {
				hKeys = append(hKeys, k)
			}
			sort.Strings(hKeys)
			for _, k := range hKeys {
				headers = append(headers, acpMCPHeader{Name: k, Value: srv.Headers[k]})
			}
			out = append(out, acpMCPServer{
				Type:    kind,
				Name:    name,
				URL:     srv.URL,
				Headers: headers,
			})
		case "stdio":
			if srv.Command == "" {
				continue
			}
			var env []acpMCPEnv
			eKeys := make([]string, 0, len(srv.Env))
			for k := range srv.Env {
				eKeys = append(eKeys, k)
			}
			sort.Strings(eKeys)
			for _, k := range eKeys {
				env = append(env, acpMCPEnv{Name: k, Value: srv.Env[k]})
			}
			out = append(out, acpMCPServer{
				Type:    "stdio",
				Name:    name,
				Command: srv.Command,
				Args:    srv.Args,
				Env:     env,
			})
		}
	}
	return out
}

func parseMCPConfigs(configs []string) []acpMCPServer {
	out := make([]acpMCPServer, 0)
	seen := make(map[string]bool)
	for _, raw := range configs {
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			continue
		}
		data := []byte(trimmed)
		if !strings.HasPrefix(trimmed, "{") {
			b, err := os.ReadFile(trimmed)
			if err != nil {
				continue
			}
			data = b
		}
		var doc struct {
			MCPServers json.RawMessage `json:"mcpServers"`
		}
		if json.Unmarshal(data, &doc) != nil {
			continue
		}
		for _, srv := range parseMCPServerMap(doc.MCPServers) {
			if seen[srv.Name] {
				continue
			}
			out = append(out, srv)
			seen[srv.Name] = true
		}
	}
	return out
}

func convertClaudeUserMessageToACPPrompt(raw json.RawMessage) []map[string]any {
	var msg struct {
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(raw, &msg) != nil || len(msg.Content) == 0 {
		return nil
	}
	var text string
	if json.Unmarshal(msg.Content, &text) == nil {
		return []map[string]any{{"type": "text", "text": text}}
	}
	var parts []map[string]any
	if json.Unmarshal(msg.Content, &parts) != nil {
		return nil
	}
	out := make([]map[string]any, 0, len(parts))
	for _, p := range parts {
		typ, _ := p["type"].(string)
		switch typ {
		case "text":
			if t, ok := p["text"].(string); ok {
				out = append(out, map[string]any{"type": "text", "text": t})
			}
		case "image":
			if src, ok := p["source"].(map[string]any); ok {
				mime, _ := src["media_type"].(string)
				data, _ := src["data"].(string)
				if mime != "" && data != "" {
					out = append(out, map[string]any{"type": "image", "mimeType": mime, "data": data})
				}
			}
		}
	}
	return out
}

func extractACPContentText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var block struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &block) == nil && block.Text != "" {
		return block.Text
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &blocks) == nil && len(blocks) > 0 {
		var sb strings.Builder
		for _, bl := range blocks {
			sb.WriteString(bl.Text)
		}
		return sb.String()
	}
	return ""
}

func extractACPOutputText(rawOutput, content json.RawMessage) string {
	if s := extractACPContentText(content); s != "" {
		return s
	}
	if len(rawOutput) == 0 {
		return ""
	}
	var str string
	if json.Unmarshal(rawOutput, &str) == nil {
		return str
	}
	return string(rawOutput)
}

func decodeJSONOrWrap(raw json.RawMessage) any {
	if len(bytes.TrimSpace(raw)) == 0 {
		return map[string]any{}
	}
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return map[string]any{}
	}
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{"value": v}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if t := strings.TrimSpace(v); t != "" {
			return t
		}
	}
	return ""
}
