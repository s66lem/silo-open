# Silo dashboard

A quota dashboard for a pooled CLIProxyAPI install: provider tabs, per-account quota charts
with forecasts, per-account status, and the everyday account actions, styled after
shadcn/ui. Layout inspired by Theo Browne's ([@t3dotgg](https://github.com/t3dotgg))
CLIProxyAPI setup; this is an independent implementation.

## Features

- Per-account quota charts for Claude, Codex, Antigravity, Devin and Grok with recorded history, burn rate,
  reset markers and a projection; scrub or arrow-key through samples.
- Total cards: one pooled card per provider above the per-account cards (remaining % summed over its accounts, from the same recorded history; a stale or missing reading breaks the line rather than dipping it).
- Rename accounts: give any account a nickname (Accounts menu, Enter saves, Esc cancels); it is stored in the dashboard's own sqlite by credential file name, never in the proxy's files, and the email stays visible as secondary text.
- Accounts: rotation switch, sign in again, reset cooldown, remove (with confirmation).
- **Add login** for every sign-in CLIProxyAPI offers: Claude, Codex, Antigravity, xAI,
  Kimi (kimi.com and kimi.ai), Devin and Meta.
- Keys: give each client its own API key, limited to chosen providers, accounts and model
  patterns, with a weekly token cap; enable, edit, rotate or delete it, and see its 7-day
  usage by hour or day, by model and by account. Needs a CLIProxyAPI with client keys
  (`/v8/management/access/client-keys`). A key's secret is shown once, after create or rotate.
- The Tokens page covers 24h, 7d, 30d and **All time**, including imported usage, with a **Tokens / API cost** switch. In **Tokens** mode, compare input + output with total tokens including cache reads and writes; in **API cost** mode, view the full page—hero cards, stacked hourly/daily charts, tooltips, and provider/account/model/client breakdown cards—in estimated USD based on published per-model API rates (with cache savings and unpriced-model honesty). The 7d, 30d and All time views show daily totals, and All time shows the daily average since the first recorded bucket. Account details show 24-hour, 7-day and all-time usage.
- Cache hit percentage and a warning when an account writes more cache than it reads help identify broken session affinity.
- Logs: failed-request logs with a viewer, and a live activity tail (opt-in: it turns on
  the proxy's file logging only when you click Enable).
- Sonner toasts, Torph text morphing, keyboard navigation, reduced-motion support.

## Design

- shadcn/ui (v4, neutral, dark) tokens and component metrics: base `#0a0a0a`, cards `#171717`, borders white/10%, muted text `#a1a1a1`, 4px grid.
- Codex blue `#82aafa`, Antigravity apricot `#e59a75`; status also uses text labels.
- Self-hosted Geist and Geist Mono; no remote requests. Sonner, React and Torph are
  bundled into `assets/vendor.js` (rebuild with `npm install && npm run build` in `vendor/`).
- Large figures always describe measured account percentages. Plans are not assumed
  to have equal token budgets. Restrictions and missing/stale readings remain visible.

## How it works

A small Python service (`server.py`, standard library only) serves the page on
`127.0.0.1:8318` and talks to CLIProxyAPI's v8 management API on `127.0.0.1:8317`.
`server.py` holds the HTTP handler and the `Hub` (polling, caps, snapshots); the
modules next to it hold the rest: `quota_readers.py` (provider quota parsing),
`history_store.py` (sqlite store and pooled series), `api_pricing.py`, `silo_accounts.py`,
`claude_routing.py` (Claude <-> Antigravity ACP quota advisor) and `request_inputs.py` (input validation). The page's script is split
into `assets/app-*.js`, plain scripts sharing one global scope, loaded in the order
`index.html` lists them (and `server.py`'s `APP_SCRIPTS` serves). `deploy.py` installs a
release copy of each script (`assets/<name>.<hash>.js`, served as immutable) and publishes an
`index.html` naming those copies, so a page loaded during a deploy or restart never mixes releases.
Copies older than the replaced page are removed, so restoring an older backed-up `index.html` by
hand also needs that backup's `assets/`.

Put it behind Tailscale Serve and/or a Cloudflare Tunnel under `/dashboard/`, and list
the public host names in `DASHBOARD_HOSTS` (other Host headers are refused):

```ini
# ~/.config/systemd/user/cliproxy-dashboard.service.d/hosts.conf
[Service]
Environment=DASHBOARD_HOSTS=proxy.example.com,box.tailnet.ts.net:8317
# Optional: these Tailscale logins skip the management key (tailnet-only setups).
Environment=DASHBOARD_TAILNET_USERS=you@github
```

`DASHBOARD_TAILNET_USERS` trusts the `Tailscale-User-Login` header, so only set it when
every route to the dashboard goes through a tailnet proxy that sets that header (Caddy's
`tailscale_auth`, or `tailscale serve`), never through a public tunnel.

A Cloudflare Tunnel should allowlist routes so the management API never becomes public
(requests arrive from loopback, so CLIProxyAPI treats them as local):

```yaml
ingress:
  - hostname: proxy.example.com
    path: ^/($|dashboard(/|$))
    service: http://127.0.0.1:8318
  - hostname: proxy.example.com
    path: ^/v1/tunnel
    service: http_status:404
  - hostname: proxy.example.com
    path: ^/(v1|v1beta)(/|$)
    service: http://127.0.0.1:8317
  - service: http_status:404
```

Sign in with the CLIProxyAPI management key. The browser receives an HttpOnly,
SameSite=Strict session cookie that lasts 400 days and renews while used (Secure on public hosts). The key and account
tokens never reach the page or browser storage. Write requests also check origin and a
custom header. Sign-in attempts are rate-limited per visitor address (the
`CF-Connecting-IP` / `X-Forwarded-For` address when behind a tunnel).

Quotas are read with quota-only requests through CLIProxyAPI (Codex
`/backend-api/wham/usage`, Antigravity `v1internal:retrieveUserQuotaSummary`, Grok OAuth
`/v1/billing?format=credits`); it never runs
model inference to check quotas, and tokens are substituted by CLIProxyAPI.

History is recorded every 30 seconds into `data/quota.sqlite` (private permissions),
sent to the browser downsampled to about 720 points per series (gzip-compressed),
and retained for 30 days. The server builds the history part of a snapshot (series and
pooled totals) at most every 20 seconds per range and reuses it, already encoded and
compressed, between polls; pages and assets are served from memory and revalidated by
ETag. No history is invented. Forecasts need ten minutes of recent,
contiguous samples for every measured account; consumption excludes reset increases.
Apart from client keys (which decide what each client may use) and the account actions
above, the dashboard never changes routing.

## Operate

The deploy script assumes CLIProxyAPI lives in `~/cliproxyapi` (binary, `config.yaml`,
`credentials.json` with `management_key`) and installs the dashboard to
`~/cliproxyapi/dashboard`. It backs up its own files and verifies the proxy binary,
config and stock panel are byte-identical afterwards.

```sh
python3 -m unittest discover -s dashboard -v     # server tests
python3 dashboard/deploy.py                      # install + restart the service
python3 dashboard/deploy.py --frontend-only      # UI only; sessions survive
systemctl --user status cliproxy-dashboard
for t in quota_units tokens_cost; do node dashboard/test_$t.cjs; done   # page logic
```

`--frontend-only` refuses to run while the installed backend modules differ from the
checkout, because the backend decides which asset files are served and the data format.

Browser tests (Playwright + Chrome): `DASHBOARD_SOURCE=1 node dashboard/test_ui.cjs`
(set `DASHBOARD_URL` to test through a public host). `DASHBOARD_ONLY=keys` runs only the
Keys checks, and `DASHBOARD_KEY_FILE` points at another `credentials.json`.
Use `DASHBOARD_SOURCE=1 DASHBOARD_ONLY=tokens node dashboard/test_ui.cjs` for the
mocked Tokens and account usage checks. They run without a dashboard server or credentials.

To try changes against a test proxy instead of the real one, run a second copy:
`CPA_URL=http://127.0.0.1:18317 DASHBOARD_PORT=18318 DASHBOARD_CREDENTIALS=/tmp/test/credentials.json
DASHBOARD_DATA=/tmp/test/data python3 dashboard/server.py`.

The design audit, direction and attributions are in `DESIGN.md`.
