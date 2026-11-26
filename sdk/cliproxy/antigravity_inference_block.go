package cliproxy

import (
	"context"
	"net/http"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
)

const antigravityInferenceBlockedMessage = "antigravity inference via CLIProxyAPI is hard-blocked; use native agy acp (/agy-native)"

// antigravityBlockedInferenceExecutor keeps Antigravity OAuth token refresh working
// for read-only quota polling and native agy acp failover, while hard-blocking every
// non-ACP execution path so no client or agent can send spoofed Cloud Code requests
// through CLIProxyAPI.
type antigravityBlockedInferenceExecutor struct {
	inner *executor.AntigravityExecutor
}

func newAntigravityBlockedInferenceExecutor(cfg *config.Config) *antigravityBlockedInferenceExecutor {
	return &antigravityBlockedInferenceExecutor{
		inner: executor.NewAntigravityExecutor(cfg),
	}
}

func antigravityBlockedError() error {
	return &coreauth.Error{
		Code:       "forbidden",
		Message:    antigravityInferenceBlockedMessage,
		HTTPStatus: http.StatusForbidden,
	}
}

func (e *antigravityBlockedInferenceExecutor) Identifier() string {
	if e != nil && e.inner != nil {
		return e.inner.Identifier()
	}
	return "antigravity"
}

func (e *antigravityBlockedInferenceExecutor) Execute(context.Context, *coreauth.Auth, cliproxyexecutor.Request, cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	return cliproxyexecutor.Response{}, antigravityBlockedError()
}

func (e *antigravityBlockedInferenceExecutor) ExecuteStream(context.Context, *coreauth.Auth, cliproxyexecutor.Request, cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
	return nil, antigravityBlockedError()
}

func (e *antigravityBlockedInferenceExecutor) CountTokens(context.Context, *coreauth.Auth, cliproxyexecutor.Request, cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	return cliproxyexecutor.Response{}, antigravityBlockedError()
}

func (e *antigravityBlockedInferenceExecutor) HttpRequest(context.Context, *coreauth.Auth, *http.Request) (*http.Response, error) {
	return nil, antigravityBlockedError()
}

func (e *antigravityBlockedInferenceExecutor) Refresh(ctx context.Context, auth *coreauth.Auth) (*coreauth.Auth, error) {
	if e == nil || e.inner == nil {
		return auth, nil
	}
	return e.inner.Refresh(ctx, auth)
}
