package cliproxy

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
)

func TestAntigravityInferenceHardBlocked(t *testing.T) {
	service := &Service{
		cfg:         &config.Config{},
		coreManager: coreauth.NewManager(nil, nil, nil),
	}
	service.registerAvailableExecutors(nil, executorRegistrationOptions{
		includeBaseline: true,
	})

	exec, ok := service.coreManager.Executor("antigravity")
	if !ok || exec == nil {
		t.Fatal("expected antigravity executor to be registered")
	}
	if _, unwrapped := exec.(coreauth.ExecutorUnwrapper); unwrapped {
		t.Fatal("blocked antigravity executor must not expose Unwrap()")
	}

	assertBlocked := func(name string, err error) {
		t.Helper()
		if err == nil {
			t.Fatalf("%s: expected error, got nil", name)
		}
		var authErr *coreauth.Error
		if !errors.As(err, &authErr) {
			t.Fatalf("%s: error type = %T (%v), want *coreauth.Error", name, err, err)
		}
		if authErr.HTTPStatus != http.StatusForbidden {
			t.Fatalf("%s: HTTPStatus = %d, want %d", name, authErr.HTTPStatus, http.StatusForbidden)
		}
		if !strings.Contains(authErr.Message, "hard-blocked") {
			t.Fatalf("%s: unexpected message %q", name, authErr.Message)
		}
	}

	auth := &coreauth.Auth{ID: "antigravity-test", Provider: "antigravity"}
	req := cliproxyexecutor.Request{Model: "claude-opus-5-5-high", Payload: []byte(`{}`)}

	_, errExec := exec.Execute(context.Background(), auth, req, cliproxyexecutor.Options{})
	assertBlocked("Execute", errExec)

	_, errStream := exec.ExecuteStream(context.Background(), auth, req, cliproxyexecutor.Options{})
	assertBlocked("ExecuteStream", errStream)

	_, errTokens := exec.CountTokens(context.Background(), auth, req, cliproxyexecutor.Options{})
	assertBlocked("CountTokens", errTokens)

	httpReq, errNew := http.NewRequest(http.MethodPost, "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent", nil)
	if errNew != nil {
		t.Fatal(errNew)
	}
	_, errHTTP := exec.HttpRequest(context.Background(), auth, httpReq)
	assertBlocked("HttpRequest", errHTTP)
}
