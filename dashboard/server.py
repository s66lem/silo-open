#!/usr/bin/env python3
"""Private quota dashboard. Account tokens stay inside CLIProxyAPI."""
import concurrent.futures
import copy
import gzip
import hashlib
import hmac
import http.cookies
import json
import os
import re
from pathlib import Path
import secrets
import sqlite3
import struct
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Split-out parts of the dashboard backend. `python -I server.py` (how the Windows hub starts it)
# leaves the script's folder off sys.path, so add it.
if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
from quota_readers import (account_detail, devin_observed, match_silo_api_key_usage, normalize_strategy,
                           number, parse_antigravity, parse_claude, parse_claude_plan, parse_claude_profile,
                           parse_codex, parse_codex_resets, parse_devin, parse_xai, parse_xai_plan,
                           pick_next_up_ids, safe_account, timestamp)
from request_inputs import (InputError, clean_nickname, clean_plan, clean_provider_order, clean_weight,
                            client_key_input, client_key_secret, default_plan_weight, safe_client_key,
                            subscription_key, subscription_terms)
from api_pricing import (MYPRIORS_REFRESH_INTERVAL, MYPRIORS_RETRY_INTERVAL, antigravity_window_group,
                         calibration_lookup, fetch_mypriors_subsidies, window_period_key)
from history_store import (CLIENT_KEY_USAGE_FIELDS, Store, downsample_series, history_gap, history_rows,
                           history_series, pool_series, pool_stack)
from silo_accounts import (CAP_WINDOWS, apply_v0_auth_file_nicknames, cap_decision, cap_label, cap_reason,
                           cap_window_key, clean_cap, clean_cap_window, config_account_aliases,
                           effective_silo_priority, evaluate_window_caps, parse_silo_deadline, quota_groups,
                           silo_api_call_response, silo_auth_file, silo_group_cap, silo_group_patterns, silo_plan,
                           silo_window_cap, silo_window_caps)
from claude_routing import decide_claude_route
from usage_breakdown import UsageBreakdownService

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("DASHBOARD_DATA", str(ROOT / "data")))
CREDENTIALS = Path(os.environ.get("DASHBOARD_CREDENTIALS", str(Path.home() / "cliproxyapi/credentials.json")))
# CLIProxyAPI and the dashboard's own port; overridable to run a second copy against a test proxy.
CPA_URL = os.environ.get("CPA_URL", "http://127.0.0.1:8317").rstrip("/")
PORT = int(os.environ.get("DASHBOARD_PORT", "8318"))
# Public host[:port] names the dashboard answers on, comma-separated (e.g. a Tailscale
# name and a Cloudflare Tunnel hostname). The first one is advertised as the API endpoint.
PUBLIC_HOSTS = [h.strip() for h in os.environ.get("DASHBOARD_HOSTS", "").split(",") if h.strip()]
LOCAL_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
# Tailscale logins that may use the dashboard without the management key, comma-separated
# (e.g. you@github). The tailnet proxy in front (Caddy's tailscale_auth or `tailscale serve`)
# sets Tailscale-User-Login on every request, replacing any value the client sent.
TRUST_CF = os.environ.get("DASHBOARD_TRUST_CF") == "1"
TAILNET_USERS = {u.strip() for u in os.environ.get("DASHBOARD_TAILNET_USERS", "").split(",") if u.strip()}
QUOTA_PROVIDERS = {"codex", "antigravity", "claude", "devin", "xai"}  # providers with quota readers
# Slower checks for providers whose quota endpoint is rate-limited. Anthropic's
# /api/oauth/usage answers about one call per two minutes per account.
# Every quota read is a real request on the account, so read rarely (council R1: 30 s polling
# looked like a bot). Each account gets a fixed 0-59 s offset so reads do not line up.
QUOTA_MIN_INTERVAL = {"claude": 300, "codex": 300, "antigravity": 300, "devin": 300, "xai": 300}
QUOTA_ERROR_RETRY_INTERVAL = 60  # retry failed quota reads sooner, backing off up to the full interval
REFRESH_MIN_INTERVAL = 60  # the Refresh button re-reads reset credits at most once a minute
QUOTA_INTERVAL = 30
ACTIVITY_INTERVAL = 5  # lightweight local loopback poll for live account activity
STRATEGY_INTERVAL = 30  # refresh routing.strategy from proxy config
TOKENS_SYNC_INTERVAL = 300  # background sync of recent client-key usage for Silo attribution and API$ calibration
CALIBRATION_INTERVAL = 300  # recompute empirical API-$ per quota window at most every 5 minutes
IN_USE_WINDOW = 180  # seconds after last observed request an account stays marked "In use"
# Codex reset credits change rarely: read them every 10 minutes and right after one is used.
RESET_INTERVAL = 600
PLAN_INTERVAL = 6 * 3600  # an account's plan rarely changes
# Optional remote/capped account registry; missing file keeps the feature inactive.
SILO_REGISTRY = Path(os.environ.get("SILO_ACCOUNTS", str(Path.home() / "prox-hub/silo-laptop-accounts.json")))
CAP_DEFAULT = {"claude": 85, "codex": 90, "antigravity": 90}  # per-provider cap when an entry omits cap_percent
SILO_API_FAMILY = {"claude": "claude", "codex": "codex", "antigravity": "openai-compatibility"}
CAP_WORKERS = 4  # registry accounts whose laptop quota is read at once
SILO_UNREADABLE_POLLS = 3  # consecutive failed quota reads before the account is paused (fail closed)
SILO_UNREADABLE = "Silo: quota unreadable"
OWNER_OVERRIDE = "Owner override"  # cap_state label: the owner resumed a Silo-paused account by hand
OWNER_PAUSE = "Paused by owner"  # cap_state label: the owner paused it from the dashboard; never Silo's to lift
# A Claude reset claim with an unknown outcome may be retried with the same request ID for 10 minutes.
RESET_RETRY_WINDOW = 600
CODEX_RESETS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"
# Must match the proxy's own client strings on the same tokens (test_server checks the Go source).
CLAUDE_UA = "claude-cli/2.1.321 (external, cli)"
CODEX_UA = "codex-tui/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.154.0)"
CODEX_ORIGINATOR = "codex-tui"
XAI_CLI_BASE_URL = "https://cli-chat-proxy.grok.com/v1"
XAI_CLI_VERSION = "1.0.46"
# Sign in once: sessions survive restarts and renew while used. 400 days is the longest
# cookie lifetime browsers accept; renewal happens at most once a day.
SESSION_TTL = 400 * 86400
SESSION_RENEW_AFTER = 86400
PAGES = {"/", "/accounts", "/keys", "/tokens", "/logs", "/subscriptions"}
APP_SCRIPTS = ["app-core.js", "app-charts.js", "app-pages.js", "app-actions.js", "app-keys.js", "app-tokens.js",
               "app-usage.js", "app-oauth.js"]  # the page's own scripts, in the order index.html loads them
STATIC_ASSETS = {"/assets/geist-sans.woff2", "/assets/geist-mono.woff2", "/assets/vendor.js", "/assets/subscriptions.js",
                 "/assets/apple-touch-icon.png", "/assets/icon.svg", "/assets/icon-32.png", "/assets/favicon.ico",
                 *("/assets/" + name for name in APP_SCRIPTS)}
ROOT_ICON_ASSETS = {
    "/favicon.ico": "/assets/favicon.ico",
    "/apple-touch-icon.png": "/assets/apple-touch-icon.png",
    "/apple-touch-icon-precomposed.png": "/assets/apple-touch-icon.png",
    "/apple-touch-icon-180x180.png": "/assets/apple-touch-icon.png",
    "/apple-touch-icon-180x180-precomposed.png": "/assets/apple-touch-icon.png",
}
OVERFLOW_PRIORITY = -1  # served only after accounts with a higher priority
PRIORITIES = {1, 0, OVERFLOW_PRIORITY}  # First, Normal, Overflow
ACCOUNT_PAGE = re.compile(r"/accounts/(?:silo(?:%3[Aa]|:))?[A-Za-z0-9_.-]{1,128}")  # one account's detail page
HISTORY_CACHE_TTL = 60  # rebuild cached history at least this often (imports write from another process)
HISTORY_REBUILD_INTERVAL = 20  # ...and at most this often, however many samples were written meanwhile
HISTORY_CACHE_RANGES = 4  # most chart ranges (hours values) kept in the history cache
# Every OAuth flow CLIProxyAPI v8 exposes through /oauth/auth-url.
OAUTH_PROVIDERS = {"claude", "codex", "antigravity", "xai", "kimi", "kimi-ai", "devin", "meta"}
ERROR_LOG_NAME = re.compile(r"^error-[A-Za-z0-9._-]+\.log$")
ERROR_LOG_LIMIT = 256 * 1024  # bytes of a failed-request log sent to the browser
# Client keys (CLIProxyAPI's access/client-keys). IDs and secrets have fixed shapes; anything else is refused.
CLIENT_KEY_ID = re.compile(r"ck_[a-z0-9]{1,40}")


def natural_sort_key(text):
    """Case-insensitive natural sort key so 'TEAM 2' sorts before 'TEAM 10'."""
    parts = re.split(r"(\d+)", str(text or "").strip().casefold())
    return tuple((0, int(p)) if p.isdigit() else (1, p) for p in parts)


class ProxyError(ValueError):
    """An HTTP error from CLIProxyAPI. The body stays server-side; only the status is public."""

    def __init__(self, status, body=b""):
        super().__init__(f"Proxy returned HTTP {status}. Check the original panel for details.")
        self.status = status
        self.body = body


def gzip_join(head, tail, tail_deflated):
    """One gzip stream for head + tail where tail_deflated is tail already compressed as finished
    raw deflate by a fresh compressor. A sync flush byte-aligns head's blocks and the tail never
    references head's bytes, so the two block runs form one valid deflate stream."""
    c = zlib.compressobj(6, zlib.DEFLATED, -15)
    body = c.compress(head) + c.flush(zlib.Z_SYNC_FLUSH)
    trailer = struct.pack("<II", zlib.crc32(tail, zlib.crc32(head)), (len(head) + len(tail)) & 0xFFFFFFFF)
    return b"\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\xff" + body + tail_deflated + trailer


ALL_PERIODS = {"5h": 5 * 3600, "7d": 7 * 86400}


_file_cache = {}
_file_cache_lock = threading.Lock()


def cached_file(path, parse):
    """parse(path), reused while the file is unchanged on disk. A file modified in the last two seconds
    is re-read every time: a same-size rewrite within one mtime tick would look unchanged. Inode and
    ctime catch replacements that keep the old mtime (copies with preserved times)."""
    try:
        stat = path.stat()
    except OSError:
        return parse(path)
    sig = (stat.st_ino, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size)
    with _file_cache_lock:
        hit = _file_cache.get((path, parse))
    if hit and hit[0] == sig and time.time() - stat.st_mtime > 2:
        return hit[1]
    value = parse(path)
    with _file_cache_lock:
        _file_cache[(path, parse)] = (sig, value)
    return value


def load_registry():
    """Silo-capped laptop accounts from the registry file. Missing, empty, or malformed file
    (or a bad entry) yields [] / skips the entry, so the feature simply stays inactive."""
    return copy.deepcopy(cached_file(SILO_REGISTRY, parse_registry))  # callers get their own copies


def parse_registry(path):
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return []
    if not isinstance(data, list):
        return []
    out, names = [], set()
    for entry in data:
        if not isinstance(entry, dict) or entry.get("provider") not in CAP_DEFAULT:
            continue
        try:
            clean = {k: str(entry[k]) for k in ("seat", "node", "silo_cpa_base", "cpakey", "hub_auth_name")}
        except (KeyError, TypeError):
            continue
        if not re.fullmatch(r"https?://[^/?#\s]+/?", clean["silo_cpa_base"]) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", clean["seat"]):
            continue
        if clean["hub_auth_name"] in names:
            continue  # the first entry wins (as silo_entry picks it); caps run per name in parallel
        names.add(clean["hub_auth_name"])
        clean["provider"] = entry["provider"]
        cap = entry.get("cap_percent", CAP_DEFAULT[entry["provider"]])
        if isinstance(cap, bool) or not isinstance(cap, (int, float)) or not 1 <= cap <= 100:
            cap = CAP_DEFAULT[entry["provider"]]
        clean["cap_percent"] = cap
        window_caps = entry.get("window_caps")
        if isinstance(window_caps, dict):
            parsed_win = {win: value for win, value in window_caps.items()
                          if win in CAP_WINDOWS and not isinstance(value, bool)
                          and isinstance(value, (int, float)) and 1 <= value <= 100}
            if parsed_win:
                clean["window_caps"] = parsed_win
        group_caps = entry.get("group_caps")
        if isinstance(group_caps, dict):
            parsed_groups, parsed_group_wins = {}, {}
            for group, value in group_caps.items():
                if not isinstance(group, str) or not group.strip():
                    continue
                if isinstance(value, dict):
                    gw = {win: wval for win, wval in value.items()
                          if win in CAP_WINDOWS and not isinstance(wval, bool)
                          and isinstance(wval, (int, float)) and 1 <= wval <= 100}
                    if gw:
                        parsed_group_wins[group] = gw
                elif not isinstance(value, bool) and isinstance(value, (int, float)) and 1 <= value <= 100:
                    parsed_groups[group] = value
            if parsed_groups:
                clean["group_caps"] = parsed_groups
            if parsed_group_wins:
                clean["group_window_caps"] = parsed_group_wins
        group_models = entry.get("group_models")
        if isinstance(group_models, dict):
            clean["group_models"] = {group: [pattern.strip() for pattern in patterns]
                                     for group, patterns in group_models.items()
                                     if group.strip() and isinstance(patterns, list) and patterns
                                     and all(isinstance(p, str) and p.strip() for p in patterns)}
        plan = str(entry.get("plan") or "").strip()
        if plan:
            clean["plan"] = plan
        weight = number(entry.get("weight"))
        if weight is not None and not isinstance(entry.get("weight"), bool) and 0.05 <= weight <= 1000:
            clean["weight"] = round(weight, 3)
        priority = entry.get("priority")
        if not isinstance(priority, bool) and isinstance(priority, int) and priority in PRIORITIES:
            clean["priority"] = priority
        priority_until = str(entry.get("priority_until") or "").strip()
        if priority_until and parse_silo_deadline(priority_until) is not None:
            clean["priority_until"] = priority_until
        out.append(clean)
    return out


def read_management_key(path):
    return json.loads(path.read_text())["management_key"]


def silo_entry(account_id):
    """The registry entry a dashboard id "silo:<hub_auth_name>" names, or None."""
    if not isinstance(account_id, str) or not account_id.startswith("silo:"):
        return None
    return next((e for e in load_registry() if e["hub_auth_name"] == account_id[5:]), None)


class Hub:
    def __init__(self, store):
        self.store = store
        self.lock = threading.RLock()
        self.refresh_lock = threading.Lock()
        self.alias_lock = threading.Lock()
        self.alias_refresh_after = 0
        self.cap_lock = threading.Lock()  # serializes Silo's cap step with the owner's pause/resume of the same account
        self.quotas = store.load()
        self.remote_quotas = {}  # Silo-cap readings per hub credential name (laptop quota, cached in memory)
        self.remote_paused = {}  # last observed hub pause state per Silo account
        self.remote_priorities = {}  # last observed hub routing priority per Silo account
        self.router_health = {"ts": 0.0, "accounts": {}, "agy_native": {}}  # cached loopback silo-router /health view
        self.request_counts = {}  # account key -> last observed success+failed count
        self.api_usage_ok = False  # True once observability/usage/api-keys has answered at least once
        self.tokens_sync_at = 0.0
        self.mypriors = store.mypriors_subsidies()
        self.mypriors_attempt_at = 0.0
        self.calibration_cache = {"ts": 0.0, "sig": None, "data": None}
        self.history_cache = {}  # hours -> history_view result, oldest range first
        self.history_builds = {}  # hours -> lock held while that range is rebuilt
        self.snapshot_gen = 0  # counts snapshot input reads, so a slower poll never replaces newer history
        self.last_used = {}  # account key -> unix timestamp of last observed inference activity
        self.routing_strategy = ""
        self.strategy_at = 0.0
        self.quota_attempts = {}
        self.quota_failures = {}
        self.reset_reads = {}
        self.plan_reads = {}
        self.profile_details = {}
        self.reset_claims = {}
        self.resetting = set()
        self.files = []
        self.error = None
        self.updated = None
        self.refreshing = False
        self.wake = threading.Event()
        self.oauth = {}
        self.login_attempts = {}
        self.v0_id_map = {}  # exposed nickname id -> real credential id for /v0/management/auth-files/models
        self.v0_silo_ids = set()  # exposed ids belonging to synthetic Idlenet seats
        self.usage_breakdown = UsageBreakdownService()
        self.claude_route_probes = {}  # agy account key -> last unstarted-window claim timestamp

    @staticmethod
    def management_key():
        # Read on every proxy call and session check; a rotated key changes the file, so the cache follows.
        return cached_file(CREDENTIALS, read_management_key)

    def request(self, path, data=None, method=None, raw=False, if_match=None, etag=False):
        """One management call. if_match guards a config write against a concurrent save (412);
        etag=True returns (body, ETag) so a read can feed that guard."""
        headers = {"Authorization": "Bearer " + self.management_key(), "Content-Type": "application/json"}
        if if_match:
            headers["If-Match"] = if_match
        req = urllib.request.Request(CPA_URL + "/v8/management/" + path, headers=headers,
            data=json.dumps(data).encode() if data is not None else None, method=method)
        try:
            with urllib.request.urlopen(req, timeout=25) as response:
                if etag:
                    return json.load(response), response.headers.get("ETag")
                return response.read() if raw else json.load(response)
        except urllib.error.HTTPError as exc:
            # Do not relay raw upstream bodies, which may contain account details or auth material.
            raise ProxyError(exc.code, exc.read()[:2048]) from None

    def proxy_v0(self, path, data=None, method=None):
        """Relay a Bearer-authenticated /v0/management request to CLIProxyAPI, returning
        (status_code, content_type, body_bytes)."""
        headers = {"Authorization": "Bearer " + self.management_key()}
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(CPA_URL + "/v0/management/" + path, headers=headers, data=data, method=method)
        try:
            with urllib.request.urlopen(req, timeout=25) as response:
                return response.status, response.headers.get("Content-Type", "application/json"), response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.headers.get("Content-Type", "application/json"), exc.read()

    def silo_usage_snapshot(self, entry):
        """Cached quota windows and effective plan for one registered Idlenet/Silo seat."""
        name = entry["hub_auth_name"]
        with self.lock:
            reading = self.remote_quotas.get(name) or {}
            saved = self.quotas.get("silo:" + name) or {}
        windows = reading.get("windows") or saved.get("windows") or self._fallback_remote_windows(
            entry["provider"], reading.get("used"), reading.get("reset_at"))
        plan = self.store.plan_overrides().get("silo:" + name) or silo_plan(entry["provider"], name, entry.get("plan"))
        return windows, plan

    def is_v0_silo_id(self, name):
        if not name:
            return False
        if name.startswith("silo:"):
            return True
        with self.lock:
            if name in self.v0_silo_ids:
                return True
        names = self.store.nicknames()
        for entry in load_registry():
            hub_name = entry["hub_auth_name"]
            display = (names.get("silo:" + hub_name) or names.get(hub_name) or "").strip() or hub_name
            if name in (hub_name, display):
                return True
        return False

    def resolve_v0_auth_id(self, name):
        with self.lock:
            mapped = self.v0_id_map.get(name)
            files = list(self.files)
        if mapped:
            return mapped
        names = self.store.nicknames()
        for f in files:
            orig_id = str(f.get("id") or f.get("name") or "")
            file_name = str(f.get("name") or orig_id)
            nick = (names.get(file_name) or names.get(orig_id) or "").strip()
            if nick and nick == name and orig_id:
                return orig_id
        return name

    def normalize_usage_buckets(self, buckets):
        candidates = [b for b in buckets if ":apikey:" in b["account"] or b["account"].startswith("openai-compatibility:")
                      or b["provider"].startswith("openai-compatible-")]
        if not candidates:
            return buckets
        registry = {e["hub_auth_name"].lower(): e for e in load_registry()}
        with self.alias_lock:
            aliases = self.store.account_aliases()
            if time.monotonic() >= self.alias_refresh_after and any(b["account"] not in aliases for b in candidates):
                try:
                    mapping = config_account_aliases(self.request("config/api-keys"), registry)
                except Exception:
                    # Older or unavailable config endpoints must not hide usage history.
                    mapping = {}
                if mapping:
                    self.store.save_account_aliases(mapping)
                    aliases = self.store.account_aliases()
                self.alias_refresh_after = time.monotonic() + 60

        compat_names = {auth_id.split(":")[1]: alias for auth_id, alias in aliases.items()
                        if auth_id.startswith("openai-compatibility:")}
        for b in candidates:
            account, provider = b["account"], b["provider"]
            if account in aliases:
                b["account"], b["provider"] = aliases[account]["account"], aliases[account]["provider"]
            elif match := re.match(r"^openai-compatibility:([^:]+):", account):
                name = match[1]
                silo = registry.get(name.lower())
                if silo:
                    b["account"], b["provider"] = "silo:" + silo["hub_auth_name"], silo["provider"]
                elif alias := compat_names.get(name.lower()):
                    b["account"], b["provider"] = alias["account"], alias["provider"]
                else:
                    b["account"], b["provider"] = name, "openai-compatible"
            elif provider.startswith("openai-compatible-"):
                silo = registry.get(provider.removeprefix("openai-compatible-").lower())
                b["provider"] = silo["provider"] if silo else "openai-compatible"
                if silo and (not account or account.startswith("openai-compatibility:")):
                    b["account"] = "silo:" + silo["hub_auth_name"]
        return buckets

    def account(self, idx):
        with self.lock:
            return next((f for f in self.files if f["auth_index"] == idx), None)

    def finish_login(self, pending, state, auth_id):
        """Settings a web-added login should match the others on. Best effort, once per sign-in:
        Codex gets websockets; Devin becomes overflow (priority -1), since Claude
        subscriptions serve Claude models first. Antigravity stays Normal."""
        provider = pending.get("provider")
        if provider == "codex":
            fields = {"websockets": True}
            if str(auth_id or "").lower().endswith("-team.json"):
                fields["default_service_tier"] = "priority"
        elif provider == "devin":
            fields = {"priority": OVERFLOW_PRIORITY}
        else:
            return
        if pending.get("account") or pending.get("configured") or not auth_id:
            return
        pending["configured"] = True
        try:
            self.request("credentials/fields", {"name": str(auth_id), **fields}, "PATCH")
        except Exception:
            pending["configured"] = False

    def _record_request_count(self, key, total, now):
        prev = self.request_counts.get(key)
        if prev is not None and total > prev:
            self.last_used[key] = max(self.last_used.get(key, 0.0), now)
        self.request_counts[key] = total

    def read_files(self):
        result = self.request("credentials")
        # Every signed-in account is listed; only QUOTA_PROVIDERS also get quota checks.
        files = [f for f in result.get("files", []) if f.get("provider")]
        now = time.time()
        with self.lock:
            for f in files:
                idx = f.get("auth_index")
                if not idx:
                    continue
                total = int(number(f.get("success")) or 0) + int(number(f.get("failed")) or 0)
                self._record_request_count(idx, total, now)
                verified = timestamp(f.get("last_inference_verified_at"))
                if verified:
                    self.last_used[idx] = max(self.last_used.get(idx, 0.0), verified)
            self.files, self.updated, self.error = files, now, None
        return files

    def read_activity(self):
        """Best-effort loopback read of routing strategy and API-key request counters.
        Never fails the collector on older proxies that lack a route."""
        now = time.time()
        with self.lock:
            need_strategy = now - self.strategy_at >= STRATEGY_INTERVAL
        if need_strategy:
            try:
                strat = normalize_strategy(self.request("config/routing/strategy"))
            except ProxyError as exc:
                strat = "round-robin" if exc.status == 404 else None
            except Exception:
                strat = None
            if strat is not None:
                with self.lock:
                    self.routing_strategy = strat
                    self.strategy_at = now
        registry = load_registry()
        if not registry:
            return
        try:
            api_usage = self.request("observability/usage/api-keys")
        except Exception:
            return
        if not isinstance(api_usage, dict):
            return
        with self.lock:
            self.api_usage_ok = True
            for entry in registry:
                total = match_silo_api_key_usage(entry, api_usage)
                self._record_request_count("silo:" + entry["hub_auth_name"], 0 if total is None else total, now)

    def sync_live_usage(self):
        """Best-effort periodic sync of recent client-key usage into tokens_live so Silo seat
        attribution and API-$ calibration have fresh hourly usage even before the Tokens page opens."""
        now = time.time()
        with self.lock:
            if now - self.tokens_sync_at < TOKENS_SYNC_INTERVAL:
                return
            self.tokens_sync_at = now
        try:
            result = self.request("access/client-keys/usage?hours=24")
            live = [{"key_id": str(b.get("key_id", "")), "hour": timestamp(b.get("hour")),
                     "provider": str(b.get("provider") or ""), "account": str(b.get("account") or ""),
                     "model": str(b.get("model") or ""),
                     **{k: int(number(b.get(k)) or 0) for k in CLIENT_KEY_USAGE_FIELDS}}
                    for b in result.get("buckets") or []]
            if live:
                self.store.save_live_buckets(live)
        except Exception:
            pass

    @staticmethod
    def headers(raw):
        headers = {"Authorization": "Bearer $TOKEN$", "Content-Type": "application/json"}
        if raw["provider"] == "codex":
            account_id = raw.get("id_token", {}).get("chatgpt_account_id")
            if account_id:
                headers["Chatgpt-Account-Id"] = account_id
            headers["User-Agent"] = CODEX_UA
            headers["Originator"] = CODEX_ORIGINATOR
        elif raw["provider"] == "claude":
            headers["anthropic-beta"] = "oauth-2025-04-20"
            # Anthropic only reports reset grants to a current CLI version.
            headers["User-Agent"] = CLAUDE_UA
        elif raw["provider"] == "xai":
            headers.update({
                "Accept": "application/json",
                "x-xai-token-auth": "xai-grok-cli",
                "x-grok-client-version": XAI_CLI_VERSION,
                "User-Agent": f"grok-pager/{XAI_CLI_VERSION} grok-shell/{XAI_CLI_VERSION} (windows; x86_64)",
            })
        return headers

    def call(self, raw, method, url, headers, data=None):
        payload = {"auth_index": raw["auth_index"], "method": method, "url": url, "header": headers}
        if data is not None:
            payload["data"] = json.dumps(data)
        response = self.request("requests/api-call", payload)
        try:
            body = json.loads(response.get("body") or "null")
        except ValueError:
            body = None
        return response.get("status_code", 0), body

    def quota_payload(self, raw):
        """The provider usage api-call body the quota poller sends for local accounts."""
        headers = self.headers(raw)
        if raw["provider"] == "codex":
            payload = {"method": "GET", "url": "https://chatgpt.com/backend-api/wham/usage", "header": headers}
        elif raw["provider"] == "claude":
            # cedar_ember adds the account's banked reset grants to the same response.
            payload = {"method": "GET", "url": "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1",
                       "header": headers}
        elif raw["provider"] == "xai":
            payload = {"method": "GET", "url": XAI_CLI_BASE_URL + "/billing?format=credits", "header": headers}
        else:
            headers["User-Agent"] = "antigravity/hub/2.23.0 linux/amd64"
            payload = {"method": "POST", "url": "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
                       "header": headers, "data": json.dumps({"project": raw.get("project_id", "")})}
        payload["auth_index"] = raw["auth_index"]
        return payload

    @staticmethod
    def parse_quota(provider, response):
        if not 200 <= response.get("status_code", 0) < 300:
            raise ValueError(f"Quota request returned HTTP {response.get('status_code', 'unknown')}. Try refreshing or signing in again.")
        data = json.loads(response.get("body", "{}"))
        parsed = {"codex": parse_codex, "claude": parse_claude, "xai": parse_xai}.get(provider, parse_antigravity)(data)
        if not parsed["windows"]:
            raise ValueError("The provider returned no quota windows.")
        parsed["observed_at"] = time.time()
        return parsed

    def fetch_devin_quota(self, raw):
        # Devin's GetUserStatus endpoint is binary Connect-RPC protobuf, so let CLIProxyAPI's own
        # Devin refresh execute it and return the parsed quota signals in JSON.
        name = str(raw.get("name") or raw.get("id") or "").strip()
        if not name:
            raise ValueError("Devin account has no credential file name.")
        try:
            response = self.request("credentials/refresh", {"name": name, "auth_index": raw["auth_index"]}, "POST")
        except ProxyError as exc:
            raise ValueError(f"Quota request returned HTTP {exc.status}. Try refreshing or signing in again.") from None
        parsed = parse_devin((response or {}).get("auth"))
        if not parsed["windows"]:
            raise ValueError("The provider returned no quota windows.")
        parsed["observed_at"] = time.time()
        return parsed

    def fetch_quota(self, raw):
        if raw["provider"] == "devin":
            return self.fetch_devin_quota(raw)
        return self.parse_quota(raw["provider"], self.request("requests/api-call", self.quota_payload(raw)))

    @staticmethod
    def _clean_remote_windows(raw_windows):
        if not isinstance(raw_windows, list):
            return []
        out = []
        for item in raw_windows:
            if not isinstance(item, dict):
                continue
            wid = str(item.get("id") or "").strip()
            label = str(item.get("label") or "").strip()
            rem = number(item.get("remaining"))
            if not wid or not label or rem is None:
                continue
            w = {"id": wid, "label": label, "remaining": round(max(0.0, min(100.0, rem)), 3),
                 "reset_at": timestamp(item.get("reset_at")), "period": number(item.get("period"))}
            if isinstance(item.get("group"), str) and item["group"].strip():
                w["group"] = item["group"]
            out.append(w)
        return out

    @staticmethod
    def _fallback_remote_windows(provider, used, reset_at):
        if used is None:
            return []
        rem = round(max(0.0, min(100.0, 100.0 - float(used))), 3)
        period = 7 * 86400
        if provider == "claude":
            return [{"id": "seven_day", "label": "Weekly limit", "remaining": rem, "reset_at": reset_at, "period": period}]
        if provider == "codex":
            return [{"id": "rate_limit:7d", "label": "Weekly limit", "remaining": rem, "reset_at": reset_at, "period": period}]
        return [{"id": "Gemini:weekly", "label": "Gemini · Weekly limit", "group": "Gemini",
                 "remaining": rem, "reset_at": reset_at, "period": period}]

    @staticmethod
    def fetch_remote_quota_detail(entry):
        """(used %, reset_at, windows) from the laptop/router quota route, authenticated with the cpakey.
        Only quota numbers and reset timestamps ever leave the laptop."""
        req = urllib.request.Request(entry["silo_cpa_base"].rstrip("/") + "/silo-cpa/quota?" + urllib.parse.urlencode({"seat": entry["seat"]}),
                                     headers={"Authorization": "Bearer " + entry["cpakey"]})
        try:
            with urllib.request.urlopen(req, timeout=60) as response:
                data = json.load(response)
        except urllib.error.HTTPError as exc:
            raise ValueError(f"Laptop quota read returned HTTP {exc.code}.") from None
        except (OSError, ValueError):
            raise ValueError("Laptop unreachable or its quota reply was unreadable.") from None
        used, reset_at = (data or {}).get("used_percent"), (data or {}).get("reset_at")
        if isinstance(used, bool) or not isinstance(used, (int, float)) or not used >= 0:  # also rejects NaN
            raise ValueError("Laptop returned an unreadable quota.")
        if reset_at is not None and (isinstance(reset_at, bool) or not isinstance(reset_at, (int, float))):
            raise ValueError("Laptop returned an unreadable reset time.")
        windows = Hub._clean_remote_windows((data or {}).get("windows"))
        return used, reset_at, windows

    @staticmethod
    def fetch_remote_quota(entry):
        """(used %, reset_at) from the laptop's own quota route over the tailnet, authenticated with
        the cpakey. The laptop reads the usage locally and returns only those numbers."""
        used, reset_at, _ = Hub.fetch_remote_quota_detail(entry)
        return used, reset_at

    def fetch_codex_resets(self, raw):
        status, body = self.call(raw, "GET", CODEX_RESETS_URL, {**self.headers(raw), "Accept": "application/json",
                                                               "OpenAI-Beta": "codex-1", "Originator": CODEX_ORIGINATOR})
        if not 200 <= status < 300 or not isinstance(body, dict):
            raise ValueError("Reset credits could not be read.")
        return parse_codex_resets(body)

    @staticmethod
    def quota_retry_wait(interval, fails):
        if fails <= 0:
            return interval
        return min(interval, QUOTA_ERROR_RETRY_INTERVAL * (2 ** min(fails - 1, 10)))

    def refresh_one(self, raw, observed_at=None):
        idx = raw["auth_index"]
        # Disabled accounts are still read (the usage call works while out of rotation), so their
        # history carries on and they rejoin the charts seamlessly when turned back on.
        if raw.get("provider") not in QUOTA_PROVIDERS:
            return
        if raw["provider"] == "xai" and raw.get("account_type") != "oauth":
            return
        interval = QUOTA_MIN_INTERVAL.get(raw["provider"])
        if interval:
            interval += int(hashlib.sha256(str(idx).encode()).hexdigest(), 16) % 60
            now = time.time()
            with self.lock:
                wait = self.quota_retry_wait(interval, self.quota_failures.get(idx, 0))
                if now - self.quota_attempts.get(idx, 0) < wait:
                    return
                self.quota_attempts[idx] = now
        try:
            quota = self.fetch_quota(raw)
            if observed_at is not None:
                quota["observed_at"] = observed_at
            if raw["provider"] == "codex":
                quota["resets"] = self.codex_resets(raw)
            if raw["provider"] == "claude":
                quota["plan"] = self.claude_plan(raw)
                quota["profile"] = self.profile_details.get(idx) or (self.quotas.get(idx) or {}).get("profile")
            if raw["provider"] == "xai":
                quota["plan"] = self.xai_plan(raw)
            self.store.save(idx, raw["provider"], quota)
            failed = False
        except Exception as exc:
            with self.lock:
                quota = copy.deepcopy(self.quotas.get(idx) or devin_observed(raw) or {"windows": []})
            quota["error"] = str(exc) if isinstance(exc, ValueError) else "Quota refresh failed. Check the connection and retry."
            failed = True
        with self.lock:
            self.quotas[idx] = quota
            if failed:
                self.quota_failures[idx] = self.quota_failures.get(idx, 0) + 1
            else:
                self.quota_failures.pop(idx, None)

    def codex_resets(self, raw):
        # A failed read keeps the last known credits; quota checks never fail because of it.
        idx, now = raw["auth_index"], time.time()
        with self.lock:
            known = (self.quotas.get(idx) or {}).get("resets")
            due = now - self.reset_reads.get(idx, 0) >= RESET_INTERVAL
            if due:
                self.reset_reads[idx] = now
        if not due:
            return known
        try:
            return self.fetch_codex_resets(raw)
        except Exception:
            return known

    def claude_plan(self, raw):
        # Read every few hours; a failed read keeps the last known plan.
        idx, now = raw["auth_index"], time.time()
        with self.lock:
            known = (self.quotas.get(idx) or {}).get("plan")
            due = now - self.plan_reads.get(idx, 0) >= PLAN_INTERVAL
            if due:
                self.plan_reads[idx] = now
        plan = None
        if due:
            try:
                status, profile = self.call(raw, "GET", "https://api.anthropic.com/api/oauth/profile", self.headers(raw))
                plan = parse_claude_plan(profile) if 200 <= status < 300 else None
                if plan and 200 <= status < 300:
                    details = parse_claude_profile(profile)
                    if details:
                        with self.lock:
                            self.profile_details[idx] = details
            except Exception:
                pass
        return plan or known or "Claude"

    def xai_plan(self, raw):
        idx, now = raw["auth_index"], time.time()
        with self.lock:
            known = (self.quotas.get(idx) or {}).get("plan")
            due = now - self.plan_reads.get(idx, 0) >= PLAN_INTERVAL
            if due:
                self.plan_reads[idx] = now
        if due:
            try:
                status, profile = self.call(raw, "GET", XAI_CLI_BASE_URL + "/user?include=subscription", self.headers(raw))
                if 200 <= status < 300:
                    return parse_xai_plan(profile) or "xAI"
            except Exception:
                pass
        return known or "xAI"

    def use_reset(self, raw, grant_id=None):
        idx = raw["auth_index"]
        with self.lock:
            if idx in self.resetting:
                raise ValueError("A reset is already running for this account.")
            self.resetting.add(idx)
            resets = copy.deepcopy((self.quotas.get(idx) or {}).get("resets") or {})
        try:
            if raw["provider"] == "codex":
                self.claim_codex(raw, grant_id)
            elif raw["provider"] == "claude":
                self.claim_claude(raw, resets, grant_id)
            else:
                raise ValueError("This provider has no manual resets.")
            try:
                self.request("routing/cooldown/reset", {"auth_index": idx}, "POST")
            except Exception:
                pass
            with self.lock:
                if raw["provider"] == "codex":
                    self.reset_reads.pop(idx, None)
                else:
                    # Show the spent grant now; Anthropic's usage endpoint answers about once per two minutes.
                    quota = self.quotas.get(idx) or {}
                    for item in (quota.get("resets") or {}).get("items", []):
                        if item["id"] == grant_id and item["left"] > 0:
                            item["left"] -= 1
                            quota["resets"]["available"] = max(0, quota["resets"]["available"] - 1)
            if raw["provider"] == "codex":
                with self.lock:
                    # A spent reset changes the quota now; skip the slow-read gate once.
                    self.quota_attempts.pop(raw["auth_index"], None)
                    self.quota_failures.pop(raw["auth_index"], None)
                self.refresh_one(raw)
        finally:
            with self.lock:
                self.resetting.discard(idx)

    def pending_claim(self, idx, key):
        # A claim whose outcome was unknown is retried with the same request ID for a while,
        # so the provider treats the retry as the same request and can't spend twice.
        with self.lock:
            pending = self.reset_claims.get((idx, key))
            if pending and time.time() - pending["created"] >= RESET_RETRY_WINDOW:
                self.reset_claims.pop((idx, key), None)
                pending = None
            return pending

    def claim_codex(self, raw, credit_id):
        idx = raw["auth_index"]
        pending = self.pending_claim(idx, credit_id) if credit_id else None
        if not pending:
            # Read the credits fresh: the chosen one must still be on the account.
            try:
                fresh = self.fetch_codex_resets(raw)
            except ValueError:
                raise ValueError("Reset credits could not be read, so none was used.") from None
            with self.lock:
                if idx in self.quotas:
                    self.quotas[idx]["resets"] = fresh
            ids = [i["id"] for i in fresh["items"]] if fresh["available"] else []
            credit_id = credit_id or next(iter(ids), None)
            if not credit_id:
                raise ValueError("This account has no resets left.")
            if credit_id not in ids:
                raise ValueError("That reset is no longer on the account, so none was used.")
            pending = {"request_id": str(uuid.uuid4()), "created": time.time()}
            with self.lock:
                self.reset_claims[(idx, credit_id)] = pending
        try:
            status, body = self.call(raw, "POST", CODEX_RESETS_URL + "/consume", self.headers(raw),
                                     {"credit_id": credit_id, "redeem_request_id": pending["request_id"]})
        except Exception:
            status, body = 0, None
        code = (body or {}).get("code") if 200 <= status < 300 else None
        declined = {"nothing_to_reset": "OpenAI says no limit has been used yet, so the reset was kept.",
                    "no_credit": "OpenAI says this account has no resets left. None was used."}
        if code in {"reset", "already_redeemed"} or code in declined or status in (401, 403, 429):
            with self.lock:
                self.reset_claims.pop((idx, credit_id), None)
        if status == 429:
            raise ValueError("OpenAI is rate limiting this account. Try again in a minute.")
        if status in (401, 403):
            raise ValueError("OpenAI rejected the login. Sign in again, then retry.")
        if code in declined:
            raise ValueError(declined[code])
        if code not in {"reset", "already_redeemed"}:
            raise ValueError("The outcome is unknown and a reset may have been spent. Retrying within 10 minutes "
                             "reuses the same request, so it can't spend a second one.")

    def claim_claude(self, raw, resets, grant_id):
        idx = raw["auth_index"]
        grant = next((g for g in resets.get("items", []) if g["id"] == grant_id), None)
        if grant is None:
            raise ValueError("That reset is no longer listed. Refresh and try again.")
        pending = self.pending_claim(idx, grant_id)
        # A pending claim already passed these checks; only its retry may skip them.
        if not pending and grant["reason"]:
            raise ValueError(f"This reset can't be used now: {grant['reason'].lower()}.")
        status, profile = self.call(raw, "GET", "https://api.anthropic.com/api/oauth/profile", self.headers(raw))
        org = str(((profile or {}).get("organization") or {}).get("uuid") or "").lower()
        if not 200 <= status < 300 or not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", org):
            raise ValueError("Anthropic's account lookup failed. Nothing was submitted.")
        if pending and pending["org"] != org:
            raise ValueError("This login now belongs to a different organization. Nothing was submitted.")
        if not pending:
            pending = {"request_id": uuid.uuid4().hex, "org": org, "created": time.time()}
            with self.lock:
                self.reset_claims[(idx, grant_id)] = pending
        try:
            status, body = self.call(raw, "POST", f"https://api.anthropic.com/api/organizations/{org}/reset_rate_limits",
                                     self.headers(raw), {"program": "cedar_ember", "grant_id": grant_id,
                                                         "request_id": pending["request_id"]})
        except Exception:
            status, body = 0, None
        result = (body or {}).get("result") if 200 <= status < 300 else None
        if status == 429:
            raise ValueError("Anthropic is rate limiting this account. Try again in a minute.")
        if status in (401, 403):
            raise ValueError("Anthropic rejected the login. Sign in again, then retry.")
        declined = {"not_limited": "Anthropic says the account isn't at a limit, so no reset was used.",
                    "cooldown": "Anthropic says the account is cooling down after a recent reset. None was used.",
                    "ineligible": "Anthropic declined the reset. None was used.",
                    "unavailable": "Anthropic declined the reset. None was used."}
        if result in {"reset", "already_used"} or result in declined:
            with self.lock:
                self.reset_claims.pop((idx, grant_id), None)
            if result in declined:
                raise ValueError(declined[result])
            return
        raise ValueError("The outcome is unknown and a reset may have been spent. Retrying within 10 minutes "
                         "reuses the same request, so it can't spend a second one.")

    def refresh(self):
        if not self.refresh_lock.acquire(blocking=False):
            return
        with self.lock:
            self.refreshing = True
        try:
            # A Silo account is a config api-key entry (cpakey as its key): never read its quota with the
            # generic hub-token call. Its quota comes only from the laptop route (fetch_remote_quota).
            silo = {e["hub_auth_name"] for e in load_registry()}
            files = [f for f in self.read_files() if f.get("name") not in silo]
            observed_at = time.time()
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(lambda raw: self.refresh_one(raw, observed_at), files))
        except Exception:
            with self.lock:
                self.error = "Cannot reach CLIProxyAPI. Check that the proxy service is running."
        finally:
            with self.lock:
                self.refreshing = False
            self.refresh_lock.release()

    def set_disabled(self, raw, disabled):
        """Pause or resume one hub credential (the same credentials/status path the Pause button uses)."""
        self.request("credentials/status", {"name": raw["name"], "auth_index": raw["auth_index"], "disabled": disabled}, "PATCH")

    # A Silo account reaches the hub as a CONFIG api-key group (api-keys.claude / api-keys.codex /
    # api-keys.openai-compatibility, the group's name = the registry's hub_auth_name), not an auth file:
    # GET credentials never lists it. Claude/Codex groups pause via "*" in each key's excluded-models
    # (matching PatchAuthFileStatus); OpenAI-compatibility groups pause via the group's disabled bool.

    @staticmethod
    def silo_family(provider):
        return SILO_API_FAMILY.get(provider, provider)

    def silo_group(self, entry):
        """(groups, etag, group) for the registry entry's api-keys group; group is None when the hub has
        no single group of that name (removed, or ambiguous)."""
        path = "config/api-keys/" + self.silo_family(entry["provider"])
        try:
            groups, tag = self.request(path, etag=True)
        except ProxyError as exc:
            if exc.status == 404:
                return [], None, None
            raise
        groups = groups if isinstance(groups, list) else []
        match = [g for g in groups if isinstance(g, dict) and g.get("name") == entry["hub_auth_name"]]
        return groups, tag, (match[0] if len(match) == 1 and match[0].get("keys") else None)

    @staticmethod
    def silo_excluded(group, key):
        # A key's own excluded-models overrides the group's (config_v8 expandV8Groups).
        own = key.get("excluded-models")
        return list(own if own is not None else group.get("excluded-models") or [])

    @staticmethod
    def silo_paused(group, provider=None):
        if Hub.silo_family(provider) == "openai-compatibility":
            return bool(group.get("disabled"))
        return all("*" in [m.strip() for m in Hub.silo_excluded(group, k)] for k in group["keys"])

    def set_silo_paused(self, entry, paused):
        """Pause/resume a Silo account's hub entry, written back whole under If-Match."""
        family = self.silo_family(entry["provider"])
        if family == "openai-compatibility":
            return self.set_silo_compat_state(entry, paused)
        groups, tag, group = self.silo_group(entry)
        if group is None:
            raise LookupError(entry["hub_auth_name"])
        for key in group["keys"]:
            models = [m for m in self.silo_excluded(group, key) if m.strip() != "*"]
            key["excluded-models"] = models + ["*"] if paused else models
            key.pop("auth_index", None)  # read-only view field; the hub strips it anyway
        self.request("config/api-keys/" + family, groups, "PUT", if_match=tag)

    def set_silo_compat_state(self, entry, disabled, excluded_models=None, managed_patterns=(), *, config=None):
        """Reconcile the compatibility entry under the ETag of the config used to decide its state."""
        groups, tag, group = config if config is not None else self.silo_group(entry)
        if group is None:
            raise LookupError(entry["hub_auth_name"])
        disabled = bool(disabled)
        existing = group.get("excluded-models") or []
        managed = set(managed_patterns)
        models = list(dict.fromkeys([m for m in existing if m not in managed] + list(excluded_models or ())))
        if disabled == bool(group.get("disabled")) and models == existing:
            return
        group["disabled"] = disabled
        if models:
            group["excluded-models"] = models
        else:
            group.pop("excluded-models", None)
        group.pop("auth_index", None)
        for key in group["keys"]:
            key.pop("auth_index", None)
        self.request("config/api-keys/openai-compatibility", groups, "PUT", if_match=tag)

    def _remote_fetch(self, entry):
        # Tests patch Hub.fetch_remote_quota to return (used, reset_at); honor that when patched.
        if type(self).fetch_remote_quota is not _ORIG_FETCH_REMOTE_QUOTA or "fetch_remote_quota" in self.__dict__:
            used, reset_at = self.fetch_remote_quota(entry)
            return used, reset_at, []
        return self.fetch_remote_quota_detail(entry)

    def remote_usage(self, entry, now):
        """Poll a laptop's real subscription quota through its silo-cpa quota route, rate-limited per
        account like the local poller. Returns (used %, reset_at, consecutive failed reads); used is
        None when the read failed. A cached reading is reused while fresh, but never past a binding
        window's reset."""
        account = entry["hub_auth_name"]
        interval = QUOTA_MIN_INTERVAL.get(entry["provider"], 300)
        interval += int(hashlib.sha256(account.encode()).hexdigest(), 16) % 60
        with self.lock:
            cached = self.remote_quotas.get(account)
            wait = self.quota_retry_wait(interval, cached.get("fails", 0)) if cached else interval
            if (cached and now - cached["observed_at"] < wait
                    and not (cached["reset_at"] is not None and cached["reset_at"] <= now)):
                if cached["used"] is None or not any(
                        w.get("reset_at") is not None and w["reset_at"] <= now
                        for w in cached.get("windows") or ()):
                    return cached["used"], cached["reset_at"], cached["fails"]
        try:
            used, reset_at, windows = self._remote_fetch(entry)
            if not windows:
                windows = self._fallback_remote_windows(entry["provider"], used, reset_at)
            reading = {"used": used, "reset_at": reset_at, "observed_at": now, "error": None, "fails": 0,
                       "windows": windows}
            quota_obj = {"plan": silo_plan(entry["provider"], account, entry.get("plan")), "windows": windows, "observed_at": now}
            self.store.save("silo:" + account, entry["provider"], quota_obj)
            with self.lock:
                self.quotas["silo:" + account] = quota_obj
                req_count = self.request_counts.get("silo:" + account) if self.api_usage_ok else None
            if req_count is not None:
                self.store.save_silo_activity(now, "silo:" + account, req_count)
        except Exception as exc:
            with self.lock:
                prev_windows = (cached or {}).get("windows") or (self.quotas.get("silo:" + account) or {}).get("windows") or []
            reading = {"used": None, "reset_at": None, "observed_at": now, "fails": (cached or {}).get("fails", 0) + 1,
                       "error": str(exc) if isinstance(exc, ValueError) else "Remote quota read failed.",
                       "windows": prev_windows}
        with self.lock:
            self.remote_quotas[account] = reading
        return reading["used"], reading["reset_at"], reading["fails"]

    def cap_error(self, account, message):
        """Keep an enforcement failure visible on the account's reading (snapshot cap_error)."""
        with self.lock:
            reading = self.remote_quotas.setdefault(account, {"used": None, "reset_at": None, "observed_at": 0, "fails": 0})
            reading["error"] = message

    def enforce_caps(self):
        """Poll and enforce every registry account's cap. Missing/empty registry -> inactive.
        Each account is handled independently so one unreachable laptop can't block the rest.
        Driven by the registry, cap_state and the hub's api-keys config, never by the credentials list
        (which does not include config api-key entries)."""
        registry = load_registry()
        if not registry:
            return
        overrides, window_overrides, now = self.store.cap_overrides(), self.store.cap_window_overrides(), time.time()

        def one(entry):
            try:
                self.enforce_cap(entry, overrides, now, window_overrides=window_overrides)
            except Exception as exc:
                detail = f"HTTP {exc.status}" if isinstance(exc, ProxyError) else type(exc).__name__
                self.cap_error(entry["hub_auth_name"], f"Silo cap enforcement failed ({detail}).")

        # Laptop quota reads are network-bound and independent; the hub writes inside enforce_cap
        # stay serialized by cap_lock.
        if len(registry) == 1:
            one(registry[0])
            return
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(CAP_WORKERS, len(registry))) as pool:
            list(pool.map(one, registry))

    def sync_silo_priority(self, entry, config, now):
        """Reconcile a Silo account's hub api-keys group priority (supporting timed priority_until)."""
        groups, tag, group = config
        account = entry["hub_auth_name"]
        raw_prio = group.get("priority", 0)
        cur_prio = raw_prio if isinstance(raw_prio, int) and not isinstance(raw_prio, bool) else 0
        if "priority" not in entry:
            with self.lock:
                self.remote_priorities[account] = cur_prio
            return config
        desired = effective_silo_priority(entry, now)
        if cur_prio == desired:
            with self.lock:
                self.remote_priorities[account] = cur_prio
            return config
        if desired == 0:
            group.pop("priority", None)
        else:
            group["priority"] = desired
        group.pop("auth_index", None)
        for key in group.get("keys") or ():
            if isinstance(key, dict):
                key.pop("auth_index", None)
        family = self.silo_family(entry["provider"])
        self.request("config/api-keys/" + family, groups, "PUT", if_match=tag)
        with self.lock:
            self.remote_priorities[account] = desired
        return self.silo_group(entry)

    def enforce_cap(self, entry, overrides, now, window_overrides=None):
        """One account's cap step. A cap_state row records who paused the account: Silo's own labels, or
        the owner's (OWNER_PAUSE / OWNER_OVERRIDE, written only by owner_set_silo). Silo only ever lifts a
        pause it made, and owner intent is read from that row, never inferred from the entry's paused
        state. A pause made outside the dashboard ("*" set, no row) is never lifted either."""
        account = entry["hub_auth_name"]
        cap = overrides.get(account, entry["cap_percent"])
        acct_win_ovr = (window_overrides or {}).get(account, {})
        win_caps = silo_window_caps(entry, overrides, acct_win_ovr)
        used, reset_at, fails = self.remote_usage(entry, now)  # network read: outside the cap lock
        interval = QUOTA_MIN_INTERVAL.get(entry["provider"], 300)
        with self.cap_lock:
            config = self.silo_group(entry)
            _, _, group = config
            if group is None:
                # Visible, not silent: without its api-keys entry this account can't be paused.
                family = self.silo_family(entry["provider"])
                return self.cap_error(account, f"Hub api-keys.{family} has no single entry named {account}; cap not enforced.")
            config = self.sync_silo_priority(entry, config, now)
            _, _, group = config
            if group is None:
                family = self.silo_family(entry["provider"])
                return self.cap_error(account, f"Hub api-keys.{family} has no single entry named {account}; cap not enforced.")
            paused = self.silo_paused(group, entry["provider"])
            with self.lock:
                self.remote_paused[account] = paused
                reading_info = self.remote_quotas.get(account) or {}
                windows = reading_info.get("windows") or []
                read_error = reading_info.get("error")
            current = self.store.cap_state().get(account)  # re-read under the lock: an owner toggle may just have landed
            label = (current or {}).get("label")
            if label == OWNER_PAUSE:
                return  # the owner's pause: never Silo's to lift
            groups = quota_groups(windows) if self.silo_family(entry["provider"]) == "openai-compatibility" else []
            if groups:
                return self._enforce_group_caps(
                    entry, groups, windows, overrides, current, paused, used, fails, now, interval, config,
                    read_error, window_overrides=window_overrides,
                )
            ev = evaluate_window_caps(windows, cap, win_caps, used=used, reset_at=reset_at, now=now) if used is not None else None
            over_cap = ev["over_cap"] if ev is not None else False
            current_window = ev["current_window"] if ev is not None else (reset_at is None or reset_at > now)
            eff_reset = ev["reset_at"] if ev is not None else reset_at
            # A reset already in the past would label (and bound an owner override of) a pause that is
            # already over: hold it one poll interval instead, then re-read.
            until = eff_reset if current_window else now + interval
            if label == OWNER_OVERRIDE:
                expiry = current["capped_until"]
                if not ((expiry is not None and now >= expiry) or (used is not None and not over_cap)):
                    return
                # Override over: fall through to normal capping now (an over-cap reading re-pauses at once).
                self.store.set_cap_state(account, None, "")
                current = label = None
            if current is None and paused:
                return  # paused outside the dashboard: not Silo's to lift
            if current is None and used is None and fails >= SILO_UNREADABLE_POLLS:
                reason = cap_reason(windows, cap, unreadable=True, error=read_error, window_caps=win_caps)
                return self.pause(entry, paused, None, SILO_UNREADABLE, reason=reason)  # fail closed: can't see the quota
            if label == SILO_UNREADABLE and used is not None and over_cap:
                # readable again but over: becomes an ordinary cap until its reset
                reason = cap_reason(windows, cap, used=used, window_caps=win_caps)
                self.store.set_cap_state(account, until, cap_label(until), reason=reason)
                current, label = {"capped_until": until, "reason": reason}, cap_label(until)
            if current is not None:
                action = "unpause" if (used is not None and not over_cap) else None
            else:
                action = "pause" if (used is not None and over_cap) else None
            if action == "unpause" and not current_window:
                action = None  # resume only on a reading of a live window (a passed reset_at is stale)
            if action == "pause":
                reason = cap_reason(windows, cap, used=used, window_caps=win_caps)
                self.pause(entry, paused, until, cap_label(until), reason=reason)
            elif action == "unpause":  # only after a valid, current, below-cap reading
                if paused:
                    self.set_silo_paused(entry, False)
                    with self.lock:
                        self.remote_paused[account] = False
                self.store.set_cap_state(account, None, "")
            elif current is not None:
                # Silo's row is authoritative: re-assert the pause if the entry is live (a resume outside
                # the dashboard). A Silo cap whose recorded window has passed is relabelled one interval on.
                if used is not None and over_cap:
                    hold = until
                    label = cap_label(hold)
                else:
                    hold = current["capped_until"]
                    if hold is not None and hold <= now:
                        hold = now + interval
                        label = cap_label(hold)
                reason = cap_reason(windows, cap, used=used, unreadable=(label == SILO_UNREADABLE),
                                    error=read_error, fallback=current.get("reason"), window_caps=win_caps)
                self.pause(entry, paused, hold, label, reason=reason)

    def _enforce_group_caps(self, entry, groups, windows, overrides, current, paused, used, fails, now, interval, config, read_error=None, window_overrides=None):
        account = entry["hub_auth_name"]
        markers = self.store.cap_group_state().get(account, {})
        group_overrides = self.store.cap_group_overrides().get(account, {})
        acct_win_ovr = (window_overrides or {}).get(account, {})
        caps = {g["group"]: silo_group_cap(entry, g["group"], overrides, group_overrides) for g in groups}
        win_caps_by_group = {
            g["group"]: silo_window_caps(
                entry, overrides, acct_win_ovr, group=g["group"], account_group_overrides=group_overrides,
            )
            for g in groups
        }
        evals = {
            g["group"]: evaluate_window_caps(
                windows, caps[g["group"]], win_caps_by_group[g["group"]],
                used=g["used"], reset_at=g["reset_at"], now=now, group=g["group"],
            )
            for g in groups
        } if used is not None else {}
        if (current or {}).get("label") == OWNER_OVERRIDE:
            expiry = current["capped_until"]
            expired = expiry is not None and now >= expiry
            under_cap = used is not None and all(not evals[g["group"]]["over_cap"] for g in groups)
            if not (expired or under_cap):
                return
            self.store.set_cap_state(account, None, "")
            current = None
        if current is None and not markers and paused:
            return  # external pause

        patterns = silo_group_patterns(entry, groups, markers)
        managed = {pattern for models in patterns.values() for pattern in models or ()}
        if used is None:
            if fails >= SILO_UNREADABLE_POLLS:
                self.set_silo_compat_state(entry, True, managed_patterns=managed, config=config)
                with self.lock:
                    self.remote_paused[account] = True
                reason = cap_reason(windows, None, unreadable=True, error=read_error)
                self.store.set_cap_state(account, None, SILO_UNREADABLE, reason=reason)
            return

        next_markers = dict(markers)  # a missing group has no fresh reading to lift its cap
        for group in groups:
            name = group["group"]
            marker = markers.get(name)
            ev = evals[name]
            over_cap = ev["over_cap"]
            current_window = ev["current_window"]
            until = ev["reset_at"] if current_window else now + interval
            if marker is None:
                action = "pause" if over_cap else None
            else:
                action = "unpause" if not over_cap else None
            if action == "pause":
                reason = cap_reason(windows, caps[name], used=group["used"], group=name, window_caps=win_caps_by_group[name])
                next_markers[name] = {"capped_until": until, "label": cap_label(until), "reason": reason}
            elif action == "unpause" and current_window:
                next_markers.pop(name)
            elif marker is not None:
                if over_cap:
                    reason = cap_reason(windows, caps[name], used=group["used"], group=name,
                                        fallback=marker.get("reason"), window_caps=win_caps_by_group[name])
                    if until != marker["capped_until"] or reason != marker.get("reason"):
                        next_markers[name] = {"capped_until": until, "label": cap_label(until), "reason": reason}
                elif marker["capped_until"] is not None and marker["capped_until"] <= now:
                    hold = now + interval
                    reason = cap_reason(windows, caps[name], used=group["used"], group=name,
                                        fallback=marker.get("reason"), window_caps=win_caps_by_group[name])
                    next_markers[name] = {"capped_until": hold, "label": cap_label(hold), "reason": reason}

        disabled = all(name in next_markers for name in caps) or any(patterns[name] is None for name in next_markers)
        excluded = None if disabled else [p for name in patterns if name in next_markers for p in patterns[name]]
        self.set_silo_compat_state(entry, disabled, excluded, managed, config=config)
        with self.lock:
            self.remote_paused[account] = disabled
        # Record transitions only after the Hub accepts the matching config state.
        if next_markers != markers or current is not None:
            self.store.save_cap_group_states(account, next_markers, clear_account_cap=current is not None)

    def owner_set_silo(self, entry, disabled):
        """The owner's Pause/Resume for a Silo account. The intent is recorded in cap_state together with
        the config write, under the cap lock, so enforce_cap reads who paused it instead of guessing and
        a concurrent cap step can't interleave."""
        name = entry["hub_auth_name"]
        with self.cap_lock:
            current = self.store.cap_state().get(name)
            markers = self.store.cap_group_state().get(name, {})
            if self.silo_family(entry["provider"]) == "openai-compatibility":
                with self.lock:
                    windows = ((self.remote_quotas.get(name) or {}).get("windows")
                               or (self.quotas.get("silo:" + name) or {}).get("windows") or [])
                patterns = silo_group_patterns(entry, quota_groups(windows), markers)
                managed = {pattern for models in patterns.values() for pattern in models or ()}
                self.set_silo_compat_state(entry, disabled, managed_patterns=managed)
            else:
                self.set_silo_paused(entry, disabled)
            with self.lock:
                self.remote_paused[name] = bool(disabled)
            if disabled:
                self.store.set_cap_state(name, None, OWNER_PAUSE)
            else:
                if (current or markers) and (current or {}).get("label") != OWNER_PAUSE:
                    # The override lasts until the last active reset or a below-cap reading from every group.
                    active = [*markers.values(), current or {}]
                    expiry = max((m["capped_until"] for m in active if m.get("capped_until") is not None), default=None)
                    self.store.set_cap_state(name, expiry, OWNER_OVERRIDE)
                else:
                    self.store.set_cap_state(name, None, "")
                if markers:
                    self.store.clear_cap_group_state(name)

    def pause(self, entry, paused, capped_until, label, reason=""):
        if not paused:  # idempotent: skip a no-op config write
            self.set_silo_paused(entry, True)
            with self.lock:
                self.remote_paused[entry["hub_auth_name"]] = True
        self.store.set_cap_state(entry["hub_auth_name"], capped_until, label, reason=reason)

    def collect(self):
        last_quota = 0
        while True:
            requested = self.wake.is_set()
            self.wake.clear()
            due_quota = requested or time.monotonic() - last_quota >= QUOTA_INTERVAL - 1
            if due_quota:
                self.refresh()
                last_quota = time.monotonic()
            else:
                try:
                    self.read_files()
                except Exception:
                    with self.lock:
                        self.error = "Cannot reach CLIProxyAPI. Showing the last recorded state."
            self.read_activity()
            self.sync_live_usage()
            if due_quota:
                try:
                    self.enforce_caps()  # self-gated to QUOTA_MIN_INTERVAL per account
                except Exception as exc:
                    with self.lock:
                        self.error = f"Silo cap check failed ({type(exc).__name__})."
                self.sync_mypriors_subsidies()
            self.wake.wait(ACTIVITY_INTERVAL)

    def sync_mypriors_subsidies(self):
        """Daily background refresh of mypriors.com/subsidies priors & plan ratios, cached in SQLite."""
        now = time.time()
        with self.lock:
            cached = self.mypriors
            fetched_at = float((cached or {}).get("fetched_at") or 0.0)
            if fetched_at and now - fetched_at < MYPRIORS_REFRESH_INTERVAL:
                return
            if now - self.mypriors_attempt_at < MYPRIORS_RETRY_INTERVAL:
                return
            self.mypriors_attempt_at = now
        try:
            data = fetch_mypriors_subsidies()
            self.store.save_mypriors_subsidies(data)
            with self.lock:
                self.mypriors = data
                self.calibration_cache = {"ts": 0.0, "sig": None, "data": None}
        except Exception:
            pass

    def api_calibration(self, accounts, priors_data=None):
        """Cached Empirical Bayes API-$ calibration across personal hub accounts."""
        priors_ts = (priors_data or {}).get("fetched_at")
        sig = (priors_ts, tuple(sorted((a["id"], a.get("provider"), a.get("weight")) for a in accounts if not a.get("silo"))))
        now = time.time()
        with self.lock:
            cached = self.calibration_cache
            if cached["data"] is not None and cached["sig"] == sig and now - cached["ts"] < CALIBRATION_INTERVAL:
                return cached["data"]
        data = self.store.api_calibration(accounts, priors_data=priors_data)
        with self.lock:
            self.calibration_cache = {"ts": now, "sig": sig, "data": data}
        return data

    @staticmethod
    def _fallback_latest(accounts, metric):
        out = {}
        for a in accounts:
            aid = a.get("id")
            if not aid:
                continue
            win = next((x for x in a["windows"] if x["id"] == metric), None)
            rem = win.get("remaining") if win else None
            if not isinstance(rem, bool) and isinstance(rem, (int, float)):
                out[aid] = (float(rem), a.get("quota_at"))
        return out

    @staticmethod
    def totals(accounts, history, bucket, cal_map=None):
        """Pooled history per quota provider and window, from the same samples the charts use."""
        gap = history_gap(bucket)
        by_metric = {}
        for r in history:  # one pass, so each pooled series below scans only its own metric
            by_metric.setdefault(r["metric"], []).append(r)
        result = {}
        for provider in QUOTA_PROVIDERS:
            mine = [a for a in accounts if a["provider"] == provider]
            weights = {a["id"]: float(a.get("weight") or 1.0) for a in mine if "id" in a}
            silo_ids = {a["id"] for a in mine if a.get("silo") and "id" in a}
            win_meta = {}
            for a in mine:
                for w in a["windows"]:
                    win_meta.setdefault(w["id"], w)
            for metric, w in win_meta.items():
                ids = [a["id"] for a in mine if "id" in a and any(x["id"] == metric for x in a["windows"])]
                usd_per_1x = None
                if cal_map is not None:
                    pk = window_period_key(w.get("period"))
                    gtag = antigravity_window_group(metric, w.get("group")) if provider == "antigravity" else None
                    usd_per_1x = calibration_lookup(cal_map, provider, pk, gtag)["usd_per_1x"]
                result.setdefault(provider, {})[metric] = downsample_series(
                    pool_series(
                        by_metric.get(metric, []), ids, metric, gap, weights=weights, usd_per_1x=usd_per_1x,
                        retired=Hub.retired_ids(mine), silo_ids=silo_ids, carry_forward=True,
                        fallback_latest=Hub._fallback_latest(mine, metric)),
                    bucket)
        result["all"] = Hub.all_totals(accounts, history, gap, cal_map=cal_map, by_metric=by_metric, bucket=bucket)
        return result

    @staticmethod
    def all_totals(accounts, history, gap, cal_map=None, by_metric=None, bucket=None):
        """Cross-provider stacked total per window length: each provider uses its own window of
        that length (Antigravity: the Gemini group when it has one). In the 5h stack a provider
        without a 5-hour window uses its shortest one, so every provider shows.

        Disabled accounts (and providers with every account disabled) are left out over the whole
        timeline, and an account or provider that starts reporting later counts at its first
        reading from the start, so the stack has no steps where members come and go."""
        if by_metric is None:
            by_metric = {}
            for r in history:
                by_metric.setdefault(r["metric"], []).append(r)
        gone = Hub.retired_ids(accounts)
        out = {}
        for key, period in ALL_PERIODS.items():
            metrics, series = {}, {}
            for provider in sorted(QUOTA_PROVIDERS):
                mine = [a for a in accounts if a["provider"] == provider and a.get("id") not in gone]
                weights = {a["id"]: float(a.get("weight") or 1.0) for a in mine if "id" in a}
                silo_ids = {a["id"] for a in mine if a.get("silo") and "id" in a}
                usable = [w for a in mine for w in a["windows"]
                          if w.get("period") and (provider != "xai" or w["id"] == "credits")]
                wins = [w for w in usable if w["period"] == period]
                if not wins and key == "5h" and usable:
                    # No 5-hour limit (Devin's daily, xAI's weekly credits): its shortest window stands in.
                    shortest = min(w["period"] for w in usable)
                    wins = [w for w in usable if w["period"] == shortest]
                if not wins:
                    continue
                chosen = next((w for w in wins if re.search("gemini", w.get("group") or "", re.I)), wins[0])
                pick = chosen["id"]
                ids = [a["id"] for a in mine if "id" in a and any(w["id"] == pick for w in a["windows"])]
                usd_per_1x = None
                if cal_map is not None:
                    gtag = antigravity_window_group(pick, chosen.get("group")) if provider == "antigravity" else None
                    usd_per_1x = calibration_lookup(cal_map, provider, window_period_key(chosen["period"]),
                                                    gtag)["usd_per_1x"]
                metrics[provider] = pick
                series[provider] = downsample_series(
                    pool_series(by_metric.get(pick, []), ids, pick, gap, weights=weights,
                                usd_per_1x=usd_per_1x, backfill=True, silo_ids=silo_ids,
                                fallback_latest=Hub._fallback_latest(mine, pick)),
                    bucket)
            out[key] = {"metrics": metrics, "points": downsample_series(pool_stack(series, gap, backfill=True), bucket)}
        return out

    @staticmethod
    def retired_ids(accounts):
        """Disabled CLIProxyAPI accounts. They are still read, but if those reads stop, their history
        ending must not end the pooled line."""
        return {a["id"] for a in accounts if "id" in a and a.get("disabled") and not a.get("silo")}

    def _router_health(self, registry):
        """Best-effort cached read of the loopback silo-router /health endpoint (never blocks snapshot)."""
        base = next((e["silo_cpa_base"].rstrip("/") for e in registry.values()
                     if e["silo_cpa_base"].startswith(("http://127.0.0.1:", "http://localhost:"))), None)
        if not base:
            return {}, {}
        now = time.time()
        with self.lock:
            if now - self.router_health["ts"] < ACTIVITY_INTERVAL:
                return dict(self.router_health["accounts"]), dict(self.router_health.get("agy_native") or {})
        accounts, agy_native = {}, {}
        try:
            with urllib.request.urlopen(base + "/health", timeout=1.5) as resp:
                data = json.load(resp)
            if isinstance(data, dict):
                if isinstance(data.get("accounts"), dict):
                    accounts = data["accounts"]
                if isinstance(data.get("agy_native"), dict):
                    agy_native = data["agy_native"]
        except (OSError, ValueError):
            pass
        with self.lock:
            self.router_health = {
                "ts": now,
                "accounts": accounts or self.router_health["accounts"],
                "agy_native": agy_native or self.router_health.get("agy_native") or {},
            }
            return dict(self.router_health["accounts"]), dict(self.router_health["agy_native"])

    def _snapshot(self, hours, include_history=True):
        with self.lock:
            self.snapshot_gen += 1
            gen = self.snapshot_gen  # orders this poll's inputs (registry onward) against other polls'
        registry = {e["hub_auth_name"]: e for e in load_registry()}
        overrides = self.store.cap_overrides() if registry else {}
        cap_state = self.store.cap_state() if registry else {}
        group_overrides = self.store.cap_group_overrides() if registry else {}
        window_overrides = self.store.cap_window_overrides() if registry else {}
        group_state = self.store.cap_group_state() if registry else {}
        router_info, agy_native = self._router_health(registry) if registry else ({}, {})
        now = time.time()
        with self.lock:
            files = self.files  # replaced whole by read_files, never mutated in place
            priors = self.mypriors
        plan_weights = (priors or {}).get("plan_weights")
        # SQLite reads stay outside the hub lock so a slow disk never stalls the collector.
        billing = self.store.subscriptions(files)
        names = self.store.nicknames()
        weights = self.store.weight_overrides()
        plans = self.store.plan_overrides()
        with self.lock:
            billing_representatives = {}
            remote = dict(self.remote_quotas)
            remote_paused = dict(self.remote_paused)
            remote_priorities = dict(self.remote_priorities)
            saved_quotas = dict(self.quotas)
            last_used_map = dict(self.last_used)
            strategy = self.routing_strategy
            agy_personal = [f["auth_index"] for f in files
                            if f.get("provider", f.get("type")) == "antigravity" and not f.get("disabled")]
            single_agy_id = agy_personal[0] if len(agy_personal) == 1 else None
            accounts = []
            for f in files:
                idx = f["auth_index"]
                quota = saved_quotas.get(idx) or devin_observed(f)
                key = subscription_key(f)
                billing_id = billing_representatives.setdefault(key, idx) if key else idx
                in_flight = 0
                candidates = [last_used_map.get(idx), timestamp(f.get("last_inference_verified_at"))]
                if idx == single_agy_id and agy_native:
                    in_flight = max(0, int(number(agy_native.get("primary_in_flight")) or 0))
                    candidates.append(number(agy_native.get("primary_last_used_at")))
                used_ts = max((t for t in candidates if t and t > 0), default=None)
                in_use = in_flight > 0 or (used_ts is not None and now - used_ts <= IN_USE_WINDOW)
                safe = safe_account(f, quota)
                detail = account_detail(f, quota)
                w_key = str(f.get("name") or idx)
                detected_plan = safe["plan"]
                p_override = plans.get(w_key)
                effective_plan = p_override or detected_plan
                plan_w = (default_plan_weight(safe["provider"], p_override, plan_weights=plan_weights) if p_override
                          else default_plan_weight(safe["provider"], detected_plan, detail.get("provider_fields"),
                                                   plan_weights=plan_weights))
                w_override = weights.get(w_key)
                accounts.append({**safe, "plan": effective_plan, "detected_plan": detected_plan,
                                 "plan_override": p_override, "nickname": names.get(f.get("name") or "", ""),
                                 "billing_id": billing_id, "subscription": billing.get(key), "detail": detail,
                                 "plan_weight": plan_w, "weight_override": w_override,
                                 "weight": w_override if w_override is not None else plan_w,
                                 "in_flight": in_flight, "last_used_at": used_ts, "in_use": in_use})
            accounts.sort(key=lambda a: (
                str(a.get("provider") or ""),
                0 if str(a.get("nickname") or "").strip() else 1,
                natural_sort_key(a.get("nickname") or a.get("email") or a.get("name") or ""),
                str(a.get("name") or ""),
            ))
            result = {"accounts": accounts, "updated_at": self.updated, "refreshing": self.refreshing,
                      "error": self.error, "now": now, "routing_strategy": strategy or None,
                      "endpoint": f"https://{(PUBLIC_HOSTS or ['localhost:8317'])[0]}/v1"}
        # Cyclone (laptop-egress) accounts: expose both the legacy `silo` summary list and first-class
        # entries in `accounts` (id = "silo:<hub_auth_name>") so Quota, pooled totals, charts, and
        # Accounts render them seamlessly alongside personal hub accounts.
        result["silo"] = []
        for name, entry in registry.items():
            marker = cap_state.get(name)
            owner = (marker or {}).get("label") if (marker or {}).get("label") in (OWNER_OVERRIDE, OWNER_PAUSE) else None
            if owner:
                marker = None  # the owner resumed or paused it; not a Silo cap
            reading = remote.get(name) or {}
            saved = saved_quotas.get("silo:" + name) or {}
            windows = reading.get("windows") or saved.get("windows") or self._fallback_remote_windows(
                entry["provider"], reading.get("used"), reading.get("reset_at"))
            quota_at = reading.get("observed_at") if reading.get("used") is not None else saved.get("observed_at")
            cap_pct = overrides.get(name, entry["cap_percent"])
            account_window_overrides = window_overrides.get(name, {})
            win_caps = silo_window_caps(entry, overrides, account_window_overrides)
            groups = quota_groups(windows)
            group_usage = {g["group"]: g["used"] for g in groups}
            group_markers = {} if owner else group_state.get(name, {})
            account_group_overrides = group_overrides.get(name, {})
            window_override_groups = [g for g, _ in account_window_overrides if g]
            group_caps = []
            for group in dict.fromkeys([*group_usage, *group_markers, *account_group_overrides, *window_override_groups]):
                group_marker = group_markers.get(group)
                group_used = group_usage.get(group)
                group_cap_pct = silo_group_cap(entry, group, overrides, account_group_overrides)
                group_win_caps = silo_window_caps(
                    entry, overrides, account_window_overrides, group=group, account_group_overrides=account_group_overrides,
                )
                group_reason = (cap_reason(windows, group_cap_pct, used=group_used, group=group,
                                           fallback=group_marker.get("reason"), window_caps=group_win_caps)
                                if group_marker is not None else None)
                group_caps.append({
                    "group": group, "cap_percent": group_cap_pct, "window_caps": group_win_caps,
                    "usage_percent": round(group_used, 3) if group_used is not None else None,
                    "capped": group_marker is not None, "capped_until": (group_marker or {}).get("capped_until"),
                    "cap_label": (group_marker or {}).get("label"), "cap_reason": group_reason, "owner": owner})
            all_capped = bool(group_caps) and all(g["capped"] for g in group_caps)
            if marker is None and all_capped:
                marker = max(group_markers.values(), key=lambda m: m["capped_until"] or 0)
            unknown_cap = (self.silo_family(entry["provider"]) == "openai-compatibility" and any(
                not models for group, models in silo_group_patterns(entry, groups, group_markers).items()
                if group in group_markers))
            paused = remote_paused.get(name, marker is not None or owner == OWNER_PAUSE or unknown_cap)
            acct_reason = None
            if marker is not None:
                if all_capped and group_caps:
                    acct_reason = " · ".join(f"{g['group']}: {g['cap_reason']}" for g in group_caps if g.get("cap_reason")) or marker.get("reason")
                else:
                    acct_reason = cap_reason(windows, cap_pct, used=reading.get("used"),
                                             unreadable=(marker.get("label") == SILO_UNREADABLE),
                                             error=reading.get("error"), fallback=marker.get("reason"),
                                             window_caps=win_caps)
            cap_status = {"capped": marker is not None, "capped_until": (marker or {}).get("capped_until"),
                          "cap_label": (marker or {}).get("label"), "cap_reason": acct_reason,
                          "window_caps": win_caps, "group_caps": group_caps, "disabled": bool(paused)}
            rinfo = router_info.get(name) or {}
            nodes = [n.strip() for n in entry["node"].split(",") if n.strip()]
            active_node = rinfo.get("active_node") or ""
            r_nodes = rinfo.get("nodes") or []
            no_idle_laptop = bool(r_nodes) and not active_node
            in_flight = max(0, int(number(rinfo.get("in_flight")) or 0))
            silo_used_candidates = [last_used_map.get("silo:" + name), number(rinfo.get("last_used_at"))]
            used_ts = max((t for t in silo_used_candidates if t and t > 0), default=None)
            in_use = in_flight > 0 or (used_ts is not None and now - used_ts <= IN_USE_WINDOW)
            result["silo"].append({
                "id": "silo:" + name, "name": name, "provider": entry["provider"], "seat": entry["seat"],
                "node": entry["node"], "cap_percent": cap_pct,
                "usage_percent": reading.get("used"), "cap_error": reading.get("error"),
                **cap_status, "owner": owner})
            detected_silo_plan = silo_plan(entry["provider"], name, entry.get("plan"))
            silo_p_override = plans.get("silo:" + name)
            effective_silo_plan = silo_p_override or detected_silo_plan
            silo_plan_w = (default_plan_weight(entry["provider"], silo_p_override, plan_weights=plan_weights) if silo_p_override
                           else (entry.get("weight") or default_plan_weight(entry["provider"], detected_silo_plan,
                                                                            plan_weights=plan_weights)))
            silo_w_override = weights.get("silo:" + name)
            silo_prio = remote_priorities.get(name, effective_silo_priority(entry, now))
            silo_detail = {"priority": silo_prio} if silo_prio else {}
            accounts.append({
                "id": "silo:" + name, "provider": entry["provider"], "email": "", "name": name,
                "subscription": billing.get("silo:" + name),
                "nickname": names.get("silo:" + name) or names.get(name) or name,
                "plan": effective_silo_plan, "detected_plan": detected_silo_plan, "plan_override": silo_p_override,
                "plan_weight": silo_plan_w, "weight_override": silo_w_override,
                "weight": silo_w_override if silo_w_override is not None else silo_plan_w,
                "status": "paused" if paused else ("unavailable" if no_idle_laptop else "active"),
                "unavailable": no_idle_laptop, "requires_sign_in": False, "cooldowns": [],
                "success": 0, "failed": 0, "windows": windows, "quota_at": quota_at,
                "quota_error": reading.get("error"), "last_refresh": None, "resets": None,
                "cooldown_until": None, "silo": True, "cap_percent": cap_pct,
                **cap_status, "cap_owner": owner,
                "nodes": nodes, "active_node": active_node, "router_nodes": r_nodes, "detail": silo_detail,
                "in_flight": in_flight, "last_used_at": used_ts, "in_use": in_use})
        next_ids = pick_next_up_ids(accounts, strategy, now)
        cal_map = self.api_calibration(accounts, priors_data=priors)
        for acct in accounts:
            acct["next_up"] = acct["id"] in next_ids
            w_mult = float(acct.get("weight") or 1.0)
            prov = acct.get("provider")
            priced = []
            for w in acct.get("windows") or []:
                cal = calibration_lookup(
                    cal_map, prov, window_period_key(w.get("period")),
                    antigravity_window_group(w.get("id"), w.get("group")) if prov == "antigravity" else None,
                    priors_data=priors)
                priced.append({**w, "api_usd": round(cal["usd_per_1x"] * w_mult, 2), "api_usd_source": cal["source"]})
            acct["windows"] = priced
        api_cal_out = {}
        for k, v in cal_map.items():
            prov = k[0]
            subkey = k[1] if len(k) == 2 else f"{k[1]}:{k[2]}"
            api_cal_out.setdefault(prov, {})[subkey] = v
        result["api_calibration"] = {
            prov: dict(sorted(entries.items()))
            for prov, entries in sorted(api_cal_out.items())
        }
        result["mypriors_synced_at"] = (priors or {}).get("fetched_at")
        result["provider_order"] = self.store.provider_order()
        silo_ids = {a["id"] for a in accounts if a.get("silo")}
        if silo_ids:
            sample_map = self.store.silo_activity_samples(hours)
            live_rows = self.store.live_buckets(since=now - (hours + 6) * 3600)
            if live_rows:
                live_rows = self.normalize_usage_buckets(live_rows)
            hourly_all = [b["hour"] for b in live_rows if b.get("hour") is not None]
            hourly_range = [min(hourly_all), max(hourly_all) + 3600] if hourly_all else None
            hourly_by_acct = {}
            for b in live_rows:
                acct = b.get("account")
                if acct in silo_ids and b.get("hour") is not None:
                    h_key = str(int(b["hour"]))
                    bucket_map = hourly_by_acct.setdefault(acct, {})
                    bucket_map[h_key] = bucket_map.get(h_key, 0) + int(b.get("requests") or 0)
            result["silo_activity"] = {
                aid: {
                    "samples": sample_map.get(aid, []),
                    "hourly": hourly_by_acct.get(aid, {}),
                    "hourly_range": hourly_range,
                }
                for aid in sorted(silo_ids)
            }
        else:
            result["silo_activity"] = {}
        if not include_history:
            return result, None
        return result, self.history_view(hours, accounts, cal_map, gen)

    def claude_routing_decision(self, model="claude-opus-5-5", claim=False):
        result, _ = self._snapshot(1, include_history=False)
        with self.lock:
            decision = decide_claude_route(
                result.get("accounts") or [],
                now=result.get("now"),
                model=model,
                probes=self.claude_route_probes,
                claim=bool(claim),
            )
        return decision

    @staticmethod
    def history_payload(view, series):
        if series:
            return view["history"]
        # Pages loaded before grouped history existed keep polling until reloaded; they get the
        # previous flat rows, field for field and in the same order.
        return history_rows(view["history"], view["legacy"])

    def snapshot(self, hours, series=True):
        result, view = self._snapshot(hours)
        return {**result, "history": self.history_payload(view, series), "history_bucket": view["bucket"],
                "history_gap": view["gap"], "totals": view["totals"]}

    def snapshot_json(self, hours, gzipped=False, series=True):
        """The snapshot as JSON bytes (gzip-compressed when asked). The history-derived part, most of
        the payload, is encoded and compressed once per history_view and spliced in after the small
        per-poll part, instead of being re-encoded and re-compressed on every poll. series=False sends
        history as flat rows, the format pages from before grouped history understand."""
        result, view = self._snapshot(hours)
        head = json.dumps(result, separators=(",", ":")).encode()[:-1]
        key = "series" if series else "flat"
        with view["encode_lock"]:  # each view is encoded and compressed once per format
            if key not in view:
                view[key] = (',"history":' + json.dumps(self.history_payload(view, series), separators=(",", ":"))
                             + ',"history_bucket":' + json.dumps(view["bucket"], separators=(",", ":"))
                             + ',"history_gap":' + json.dumps(view["gap"], separators=(",", ":"))
                             + ',"totals":' + json.dumps(view["totals"], separators=(",", ":")) + "}").encode()
            if gzipped and key + ".gz" not in view:
                tail = zlib.compressobj(6, zlib.DEFLATED, -15)
                view[key + ".gz"] = tail.compress(view[key]) + tail.flush()
        if not gzipped:
            return head + view[key]
        return gzip_join(head, view[key], view[key + ".gz"])

    @staticmethod
    def totals_signature(accounts, cal_map):
        """Every account and calibration field Hub.totals reads, so a cached result is reused only
        while it would come out the same."""
        return (tuple((a.get("id"), a["provider"], a.get("weight"), bool(a.get("silo")), a.get("id") in Hub.retired_ids([a]),
                       tuple((w["id"], w.get("period"), w.get("group")) for w in a["windows"])) for a in accounts),
                tuple(sorted((k, v.get("usd_per_1x"), (v.get("obs_1x_drop") or 0) > 0)  # calibration_lookup reads both
                             for k, v in cal_map.items())))

    def history_view(self, hours, accounts, cal_map, gen=0):
        """History series, pooled totals, and their encoded JSON for one range. Rebuilt at once when
        the accounts or calibration change; otherwise when new samples were written (at most every
        HISTORY_REBUILD_INTERVAL) or HISTORY_CACHE_TTL passes (the range slides, and
        import_history.py writes from another process)."""
        sig = self.totals_signature(accounts, cal_map)

        def fresh():
            cached = self.history_cache.get(hours)
            if cached and cached["sig"] == sig:
                age = time.monotonic() - cached["built"]
                # New samples arrive every few seconds across accounts; history is bucketed at 2+ minutes
                # and live values ride in accounts, so a rebuild per write would only burn CPU.
                if age < HISTORY_REBUILD_INTERVAL or (cached["version"] == self.store.version and age < HISTORY_CACHE_TTL):
                    # Reused by inputs read at gen, so a build from older inputs must not replace it.
                    cached["gen"] = max(cached["gen"], gen)
                    return cached
            return None

        with self.lock:
            cached = fresh()
            if cached:
                return cached
            build = self.history_builds.setdefault(hours, threading.Lock())
        # One build per range at a time: polls arriving meanwhile wait for it and reuse it.
        with build:
            with self.lock:
                cached = fresh()
                if cached:
                    return cached
            return self.build_history_view(hours, accounts, cal_map, sig, gen)

    def build_history_view(self, hours, accounts, cal_map, sig, gen=0):
        version, now = self.store.version, time.monotonic()  # read before the query
        bucket = self.store.bucket(hours)
        rows = self.store.history(hours)
        history, legacy = history_series(rows)
        view = {"sig": sig, "gen": gen, "version": version, "built": now, "bucket": bucket, "gap": history_gap(bucket),
                "history": history, "legacy": legacy, "totals": self.totals(accounts, rows, bucket, cal_map=cal_map),
                "encode_lock": threading.Lock()}
        with self.lock:
            current = self.history_cache.get(hours)
            if current and current["gen"] > gen:
                return view  # a poll that read newer accounts already published; keep its result
            self.history_cache.pop(hours, None)
            self.history_cache[hours] = view
            while len(self.history_cache) > HISTORY_CACHE_RANGES:
                self.history_cache.pop(next(iter(self.history_cache)))
        return view


_ORIG_FETCH_REMOTE_QUOTA = Hub.fetch_remote_quota

STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".woff2": "font/woff2",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}
PRECOMPRESSED_TYPES = {".woff2", ".png", ".ico"}
_static = {}  # path -> ((ino, mtime_ns, ctime_ns, size), etag, raw bytes, gzip bytes or None)
_static_lock = threading.Lock()
PINNED_SCRIPT = re.compile(r"/assets/([a-z-]+)\.([0-9a-f]{20})\.js")


def static_file(path):
    """A served file's bytes, gzip copy, and ETag, read and compressed once per change on disk.
    Inode and ctime are part of the key because deploy.py's copies keep the source's mtime."""
    stat = path.stat()
    with _static_lock:
        hit = _static.get(path)
    sig = (stat.st_ino, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size)
    if hit and hit[0] == sig:
        return hit
    raw = path.read_bytes()
    # mtime=0 keeps the gzip bytes identical for identical files, as their strong ETag promises.
    packed = gzip.compress(raw, 9, mtime=0) if path.suffix not in PRECOMPRESSED_TYPES and len(raw) > 1024 else None
    hit = (sig, '"' + hashlib.sha256(raw).hexdigest()[:20] + '"', raw, packed)
    with _static_lock:
        _static[path] = hit
        # deploy.py removes old release copies; drop their bytes too.
        for gone in [p for p in _static if not p.exists()]:
            del _static[gone]
    return hit


def pinned_script(path):
    """A release's copy of a page script, assets/<name>.<hash>.js, which deploy.py writes before
    publishing an index.html naming it (so each page loads one release's scripts), or None. Any copy
    on disk is served, even of a script the current release renamed or dropped: the page being
    replaced may still ask for it."""
    match = PINNED_SCRIPT.fullmatch(path)
    if not match:
        return None
    file = ROOT / "assets" / (match[1] + "." + match[2] + ".js")
    return file if file.is_file() else None


class Handler(BaseHTTPRequestHandler):
    server_version = "silo"

    def log_message(self, *args):
        pass  # Never log keys, OAuth URLs, email addresses, or cookies.

    @property
    def hub(self):
        return self.server.hub

    def accepts_gzip(self):
        return "gzip" in self.headers.get("Accept-Encoding", "")

    def send(self, status, body, content_type="application/json", cookie=None, gzipped=None, etag=None, cache=None):
        """Send a response. gzipped=None compresses large bodies here; True means body is already
        gzip-compressed. With an etag, the browser revalidates instead of re-downloading."""
        payload = json.dumps(body, separators=(",", ":")).encode() if content_type == "application/json" and not isinstance(body, bytes) else body
        if gzipped is None and len(payload) > 1024 and self.accepts_gzip():
            payload, gzipped = gzip.compress(payload, 6), True
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        if gzipped:
            self.send_header("Content-Encoding", "gzip")
        if gzipped is not None or etag:
            self.send_header("Vary", "Accept-Encoding")
        if status != 304:
            self.send_header("Content-Length", str(len(payload)))
        if etag:
            self.send_header("ETag", etag)
        self.send_header("Cache-Control", cache or ("no-cache" if etag else "no-store"))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
        cookie = cookie or getattr(self, "renewed_cookie", None)
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def send_static(self, hit, content_type, cache=None):
        _, etag, raw, packed = hit
        use_gzip = packed is not None and self.accepts_gzip()
        tag = etag[:-1] + ('-gz"' if use_gzip else '"')  # each encoding is its own representation
        # If-None-Match uses weak comparison, so a W/ prefix still matches; * matches any current file.
        wanted = {t.strip().removeprefix("W/") for t in self.headers.get("If-None-Match", "").split(",")}
        if tag in wanted or "*" in wanted:
            self.send(304, b"", content_type, gzipped=False, etag=tag, cache=cache)
            return
        self.send(200, packed if use_gzip else raw, content_type, gzipped=use_gzip, etag=tag, cache=cache)

    def client_ip(self):
        # Tailscale Serve and Cloudflare Tunnel both connect from loopback; rate-limit
        # sign-in by the visitor's address they forward instead of by the tunnel.
        if self.client_address[0] in {"127.0.0.1", "::1"}:
            # The proxy hop appends the visitor on the right; anything to its left is client-supplied.
            # CF-Connecting-IP is only trusted when the dashboard sits behind Cloudflare.
            forwarded = ((self.headers.get("CF-Connecting-IP") if TRUST_CF else "")
                         or self.headers.get("X-Forwarded-For", "").split(",")[-1])
            if forwarded.strip():
                return forwarded.strip()
        return self.client_address[0]

    @staticmethod
    def digest(value):
        return hashlib.sha256(value.encode()).hexdigest()

    def session_cookie(self, token, max_age=SESSION_TTL):
        secure = "" if self.headers.get("Host", "") in LOCAL_HOSTS else "; Secure"
        return f"prox_session={token}; Path=/dashboard; HttpOnly; SameSite=Strict; Max-Age={max_age}{secure}"

    def session(self):
        try:
            cookies = http.cookies.SimpleCookie(self.headers.get("Cookie", ""))
            token = cookies["prox_session"].value
        except (KeyError, http.cookies.CookieError):
            return None
        token_hash, now = self.digest(token), time.time()
        row = self.hub.store.session(token_hash)
        # A rotated management key ends every session issued under the old one.
        if not row or row[0] <= now or not hmac.compare_digest(row[1], self.digest(self.hub.management_key())):
            return None
        if row[0] - now < SESSION_TTL - SESSION_RENEW_AFTER:
            self.hub.store.renew_session(token_hash, now + SESSION_TTL)
            self.renewed_cookie = self.session_cookie(token)
        return token

    def tailnet_user(self):
        login = self.headers.get("Tailscale-User-Login", "")
        # Only a proxy on this machine can vouch for a login, and never one relaying the public internet.
        if (login in TAILNET_USERS and self.client_address[0] in {"127.0.0.1", "::1"}
                and not self.headers.get("CF-Connecting-IP")):
            return login
        return None

    def route(self):
        host = self.headers.get("Host", "")
        if host not in LOCAL_HOSTS and host not in PUBLIC_HOSTS:
            self.send(403, {"error": "Unrecognized host."})
            return
        if self.headers.get("Tailscale-Funnel-Request"):
            # Funnel relays the public internet; the dashboard is tailnet-only.
            self.send(403, {"error": "Not available here."})
            return
        url = urllib.parse.urlsplit(self.path)
        if url.path in {"/v0/management/auth-files", "/v0/management/auth-files/models", "/v0/management/api-call"}:
            self.management_usage_shim(url)
            return
        path = url.path.removeprefix("/dashboard").rstrip("/") or "/"
        is_read = self.command in ("GET", "HEAD")
        # Pages use clean paths (/dashboard/accounts); each one serves the same app.
        if is_read and (path in PAGES or ACCOUNT_PAGE.fullmatch(path)):
            self.send_static(static_file(ROOT / "index.html"), STATIC_TYPES[".html"])
            return
        asset_path = ROOT_ICON_ASSETS.get(path, path)
        if is_read and asset_path in STATIC_ASSETS:
            file = ROOT / asset_path.lstrip("/")
            self.send_static(static_file(file), STATIC_TYPES[file.suffix])
            return
        pinned = pinned_script(path) if is_read else None
        if pinned:
            try:
                hit = static_file(pinned)
            except OSError:  # a deploy pruned it just now
                hit = None
            if hit:
                # A pinned URL always names the same bytes, so browsers need not revalidate it.
                self.send_static(hit, STATIC_TYPES[".js"], "max-age=31536000, immutable")
            else:
                self.send(404, {"error": "Not found"})
            return
        if self.command == "POST":
            origin = self.headers.get("Origin")
            if (origin and origin not in {f"https://{host}", f"http://{host}"}) or self.headers.get("X-Dashboard-Request") != "1":
                self.send(403, {"error": "Reload the dashboard and try again."})
                return
        if path == "/api/session" and self.command == "GET":
            tailnet = bool(self.tailnet_user())
            self.send(200, {"authenticated": tailnet or bool(self.session()), "tailnet": tailnet})
            return
        body = {}
        if self.command == "POST":
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > 16384:
                self.send(413, {"error": "Request is too large."})
                return
            body = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(body, dict):
                raise ValueError("Expected a JSON object.")
        if path == "/api/login" and self.command == "POST":
            now = time.time()
            with self.hub.lock:
                if len(self.hub.login_attempts) > 1000:
                    self.hub.login_attempts = {ip: ts for ip, ts in self.hub.login_attempts.items() if ts and ts[-1] > now - 300}
                attempts = [t for t in self.hub.login_attempts.get(self.client_ip(), []) if t > now - 300]
                if len(attempts) >= 10:
                    self.send(429, {"error": "Too many attempts. Try again in five minutes."})
                    return
                self.hub.login_attempts[self.client_ip()] = attempts + [now]
            supplied = str(body.get("key", ""))
            if not hmac.compare_digest(hashlib.sha256(supplied.encode()).digest(), hashlib.sha256(self.hub.management_key().encode()).digest()):
                self.send(401, {"error": "Management key not recognized."})
                return
            token = secrets.token_urlsafe(32)
            self.hub.store.add_session(self.digest(token), now + SESSION_TTL, self.digest(supplied))
            with self.hub.lock:
                self.hub.login_attempts.pop(self.client_ip(), None)
            self.send(200, {"ok": True}, cookie=self.session_cookie(token))
            return
        if path == "/api/routing/claude" and self.command == "GET":
            local_loopback = (
                self.client_address[0] in {"127.0.0.1", "::1"}
                and host in LOCAL_HOSTS
                and not self.headers.get("CF-Connecting-IP")
                and not self.headers.get("X-Forwarded-For")
            )
            if not (local_loopback or self.session() or self.tailnet_user() or self.bearer_management_ok()):
                self.send(401, {"error": "Sign in with your management key."})
                return
            query = urllib.parse.parse_qs(url.query)
            model = str(query.get("model", ["claude-opus-5-5"])[0] or "claude-opus-5-5").strip()
            if len(model) > 128 or re.search(r"[\x00-\x1f\x7f-\x9f]", model):
                raise InputError("Invalid model parameter.")
            claim = query.get("claim", [""])[0].lower() in {"1", "true", "yes"}
            self.send(200, self.hub.claude_routing_decision(model=model, claim=claim))
            return
        session = self.session()
        if not session and not self.tailnet_user():
            self.send(401, {"error": "Sign in with your management key."})
            return
        if path == "/api/logout" and self.command == "POST":
            if session:
                self.hub.store.end_session(self.digest(session))
            self.send(200, {"ok": True}, cookie=self.session_cookie("", max_age=0))
        elif path == "/api/snapshot" and self.command == "GET":
            query = urllib.parse.parse_qs(url.query)
            hours = int(query.get("hours", ["24"])[0])
            gzipped = self.accepts_gzip()
            series = query.get("history") == ["series"]
            self.send(200, self.hub.snapshot_json(min(max(hours, 1), 24 * 30), gzipped=gzipped, series=series),
                      gzipped=gzipped)
        elif path == "/api/usage/breakdown" and self.command == "GET":
            query = urllib.parse.parse_qs(url.query)
            try:
                hours = min(max(int(query.get("hours", ["24"])[0]), 1), 336)
            except ValueError:
                raise InputError("Invalid hours parameter.")
            provider = str(query.get("provider", ["all"])[0] or "all").strip().lower()
            if provider != "all" and not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,31}", provider):
                raise InputError("Invalid provider filter.")
            self.send(200, self.hub.usage_breakdown.breakdown(self.hub.store, hours=hours, provider=provider))
        elif path == "/api/refresh" and self.command == "POST":
            with self.hub.lock:
                now = time.time()
                if now - getattr(self.hub, "last_refresh", 0) >= REFRESH_MIN_INTERVAL:
                    self.hub.last_refresh = now
                    self.hub.reset_reads.clear()
            self.hub.wake.set()
            self.send(202, {"ok": True})
        elif path == "/api/account/subscription" and self.command == "POST":
            idx = str(body.get("id", ""))
            shared = silo_entry(idx) is not None
            raw = None if shared else self.hub.account(idx)
            if not shared and raw is None:
                self.send(404, {"error": "Account no longer exists. Refresh the dashboard."})
                return
            key = idx if shared else subscription_key(raw)
            if not key:
                raise InputError("This account has no stable billing identifier.")
            terms = subscription_terms(body, shared)
            with self.hub.lock:
                self.hub.store.set_subscription(key, terms)
            self.send(200, terms if terms is not None else {"cleared": True})
        elif path == "/api/account/rename" and self.command == "POST":
            idx = str(body.get("id", ""))
            nickname = clean_nickname(body.get("nickname"))
            entry = silo_entry(idx)
            if entry is not None:
                self.hub.store.set_nickname("silo:" + entry["hub_auth_name"], nickname)
                self.send(200, {"nickname": nickname})
                return
            raw = self.hub.account(idx)
            if raw is None:
                self.send(404, {"error": "Account no longer exists. Refresh the dashboard."})
                return
            file = str(raw.get("name") or "")
            if not file:
                raise InputError("This account has no credential file name to key a nickname on.")
            self.hub.store.set_nickname(file, nickname)
            self.send(200, {"nickname": nickname})
        elif path == "/api/provider-order" and self.command == "GET":
            self.send(200, {"order": self.hub.store.provider_order()})
        elif path == "/api/provider-order" and self.command == "POST":
            order = clean_provider_order(body.get("order"))
            self.hub.store.set_setting("provider_order", order)
            self.send(200, {"order": order})
        elif path == "/api/account/priority" and self.command == "POST":
            raw = self.hub.account(str(body.get("id", "")))
            if raw is None:
                self.send(404, {"error": "Account no longer exists. Refresh the dashboard."})
                return
            priority = body.get("priority")
            if isinstance(priority, bool) or priority not in PRIORITIES:
                raise InputError("Choose First, Normal or Overflow.")
            self.hub.request("credentials/fields", {"name": str(raw.get("name") or ""), "priority": priority}, "PATCH")
            self.hub.read_files()
            self.send(200, {"priority": priority})
        elif path == "/api/account/cap" and self.command == "POST":
            entry = silo_entry(body.get("id"))
            if entry is None:
                raise InputError("This account is not a Silo-capped account.")
            cap = clean_cap(body.get("cap_percent"))
            group = body.get("group")
            window = clean_cap_window(body.get("window"))
            result = {"cap_percent": cap}
            if group is not None and group != "":
                if not isinstance(group, str) or len(group) > 64 or re.search(r"[\x00-\x1f\x7f-\x9f]", group):
                    raise InputError("The quota group must be 1 to 64 characters without control characters.")
                result["group"] = group
            else:
                group = ""
            if window is not None:
                self.hub.store.set_cap_window_override(entry["hub_auth_name"], group, window, cap)
                result["window"] = window
            elif group:
                self.hub.store.set_cap_group_override(entry["hub_auth_name"], group, cap)
                if cap is not None:
                    self.hub.store.clear_cap_window_overrides(entry["hub_auth_name"], group)
            else:
                self.hub.store.set_cap_override(entry["hub_auth_name"], cap)
                if cap is not None:
                    self.hub.store.clear_cap_window_overrides(entry["hub_auth_name"], "")
            self.hub.wake.set()  # re-evaluate the cap on the next poll cycle
            self.send(200, result)
        elif path == "/api/account/weight" and self.command == "POST":
            idx = str(body.get("id", ""))
            weight = clean_weight(body.get("weight"))
            entry = silo_entry(idx)
            if entry is not None:
                self.hub.store.set_weight_override("silo:" + entry["hub_auth_name"], weight)
                self.send(200, {"weight": weight})
                return
            raw = self.hub.account(idx)
            if raw is None:
                self.send(404, {"error": "Account no longer exists. Refresh the dashboard."})
                return
            w_key = str(raw.get("name") or idx)
            self.hub.store.set_weight_override(w_key, weight)
            self.send(200, {"weight": weight})
        elif path == "/api/account/plan" and self.command == "POST":
            idx = str(body.get("id", ""))
            plan = clean_plan(body.get("plan"))
            entry = silo_entry(idx)
            if entry is not None:
                self.hub.store.set_plan_override("silo:" + entry["hub_auth_name"], plan)
                self.send(200, {"plan": plan})
                return
            raw = self.hub.account(idx)
            if raw is None:
                self.send(404, {"error": "Account no longer exists. Refresh the dashboard."})
                return
            p_key = str(raw.get("name") or idx)
            self.hub.store.set_plan_override(p_key, plan)
            self.send(200, {"plan": plan})
        elif path == "/api/account/status" and self.command == "POST":
            idx = str(body.get("id", ""))
            if not isinstance(body.get("disabled"), bool):
                raise ValueError("Choose whether the account should be paused.")
            entry = silo_entry(idx)
            if entry is not None:
                self.hub.owner_set_silo(entry, body["disabled"])  # records owner intent in cap_state
                self.hub.wake.set()
                self.send(200, {"ok": True})
                return
            with self.hub.lock:
                raw = next((f for f in self.hub.files if f["auth_index"] == idx), None)
            if raw is None:
                raise ValueError("Account no longer exists. Refresh the dashboard.")
            self.hub.set_disabled(raw, body["disabled"])
            self.hub.read_files()
            self.hub.wake.set()
            self.send(200, {"ok": True})
        elif path == "/api/oauth/start" and self.command == "POST":
            provider = body.get("provider")
            if provider not in OAUTH_PROVIDERS:
                raise ValueError("Choose Codex or Antigravity.")
            result = self.hub.request("oauth/auth-url", {"provider": provider, "is_webui": True})
            with self.hub.lock:
                self.hub.oauth[result["state"]] = {"provider": provider, "session": session, "created": time.time()}
            self.send(200, {k: result[k] for k in ["url", "state"]})
        elif path in {"/api/oauth/status", "/api/oauth/callback", "/api/oauth/cancel"} and self.command == "POST":
            state = str(body.get("state", ""))
            with self.hub.lock:
                pending = self.hub.oauth.get(state)
            if not pending or pending["session"] != session or time.time() - pending["created"] > 600:
                raise ValueError("This sign-in has expired. Start again.")
            if path.endswith("callback"):
                callback = str(body.get("redirect_url", ""))
                parsed = urllib.parse.urlsplit(callback)
                query = urllib.parse.parse_qs(parsed.query)
                if parsed.hostname not in {"localhost", "127.0.0.1", "::1"} or query.get("state", [None])[0] != state or not query.get("code"):
                    raise ValueError("The callback does not match this sign-in.")
                result = self.hub.request("oauth/callback", {"provider": pending["provider"], "state": state, "redirect_url": callback})
            elif path.endswith("cancel"):
                result = self.hub.request("oauth/session?" + urllib.parse.urlencode({"state": state}), method="DELETE")
                with self.hub.lock:
                    self.hub.oauth.pop(state, None)
            else:
                result = self.hub.request("oauth/status?" + urllib.parse.urlencode({"state": state}))
                if result.get("status") == "ok":
                    self.hub.finish_login(pending, state, result.get("auth_id"))
                    self.hub.wake.set()
            # OAuth status can include credential records. Return only status and a generic error.
            self.send(200, {"status": result.get("status", "ok"), "error": "Sign-in failed or expired. Start again." if result.get("error") else None})
        elif path == "/api/account/reset-options" and self.command == "POST":
            raw = self.hub.account(str(body.get("id", "")))
            if not raw or raw.get("provider") != "codex":
                raise ValueError("Select a Codex account to check its reset credits.")
            resets = self.hub.fetch_codex_resets(raw)
            with self.hub.lock:
                if raw["auth_index"] in self.hub.quotas:
                    self.hub.quotas[raw["auth_index"]]["resets"] = resets
            self.send(200, resets)
        elif path == "/api/account/reset" and self.command == "POST":
            raw = self.hub.account(str(body.get("id", "")))
            if raw is None:
                self.send(404, {"error": "Account no longer exists. Refresh the dashboard."})
                return
            grant = body.get("grant")
            try:
                self.hub.use_reset(raw, str(grant) if grant is not None else None)
            except ValueError as exc:
                # These messages are written here and say whether a reset may have been spent.
                self.send(409, {"error": str(exc)})
                return
            self.send(200, {"status": "ok"})
        elif path in {"/api/account/relogin", "/api/account/cooldown", "/api/account/remove"} and self.command == "POST":
            idx = str(body.get("id", ""))
            raw = self.hub.account(idx)
            if raw is None:
                self.send(404, {"error": "Account no longer exists. Refresh the dashboard."})
                return
            if path.endswith("relogin"):
                # Re-authorizes the same credential file; the proxy keeps its settings.
                result = self.hub.request("oauth/auth-url", {"provider": raw["provider"], "auth_index": idx, "is_webui": True}, "POST")
                with self.hub.lock:
                    self.hub.oauth[result["state"]] = {"provider": raw["provider"], "session": session,
                                                       "created": time.time(), "account": idx}
                self.send(200, {k: result[k] for k in ["url", "state"]})
            elif path.endswith("cooldown"):
                self.hub.request("routing/cooldown/reset", {"auth_index": idx}, "POST")
                self.hub.wake.set()
                self.send(200, {"status": "ok"})
            else:
                name = str(raw.get("name") or "")
                if not name or "/" in name or "\\" in name or ".." in name:
                    raise ValueError("This account's credential file cannot be removed here.")
                # One named file only; the proxy's all=true mode is never used.
                self.hub.request("credentials?" + urllib.parse.urlencode({"name": name}), method="DELETE")
                self.hub.read_files()
                with self.hub.lock:
                    self.hub.quotas.pop(idx, None)
                self.hub.store.forget(idx)
                self.send(200, {"status": "ok"})
        elif path.startswith("/api/keys"):
            self.client_keys(path, url, body)
        elif path == "/api/logs/errors" and self.command == "GET":
            result = self.hub.request("observability/logs/errors")
            files = [{k: f.get(k) for k in ["name", "size", "modified"]} for f in result.get("files", [])
                     if ERROR_LOG_NAME.match(str(f.get("name", "")))]
            self.send(200, {"files": files})
        elif path == "/api/logs/errors/file" and self.command == "GET":
            name = urllib.parse.parse_qs(url.query).get("name", [""])[0]
            if not ERROR_LOG_NAME.match(name):
                raise ValueError("Unknown log file.")
            try:
                data = self.hub.request("observability/logs/errors/" + urllib.parse.quote(name), raw=True)
            except ProxyError as exc:
                if exc.status == 404:
                    self.send(404, {"error": "This log file no longer exists."})
                    return
                raise
            self.send(200, {"name": name, "text": data[:ERROR_LOG_LIMIT].decode("utf-8", "replace"),
                            "truncated": len(data) > ERROR_LOG_LIMIT})
        elif path == "/api/logs/activity" and self.command == "GET":
            query = urllib.parse.parse_qs(url.query)
            params = {"limit": min(max(int(query.get("limit", ["300"])[0]), 1), 500)}
            if query.get("after", [""])[0]:
                params["after"] = int(float(query["after"][0]))
            if query.get("cursor", [""])[0]:
                params["cursor"] = query["cursor"][0]
            try:
                result = self.hub.request("observability/logs?" + urllib.parse.urlencode(params))
            except ProxyError as exc:
                if exc.status == 400 and b"logging to file disabled" in exc.body:
                    self.send(200, {"enabled": False, "lines": []})
                    return
                raise
            self.send(200, {"enabled": True, "lines": result.get("lines") or [],
                            "latest": result.get("latest-timestamp"), "next_cursor": result.get("next-cursor")})
        elif path == "/api/logs/activity/enable" and self.command == "POST":
            # The only proxy setting this dashboard changes, and only on an explicit click.
            self.hub.request("config/observability/logs/logging-to-file", True, "PUT")
            self.send(200, {"enabled": True})
        else:
            self.send(404, {"error": "Page not found."})

    def bearer_management_ok(self):
        auth = self.headers.get("Authorization", "")
        parts = auth.split(None, 1)
        if len(parts) != 2 or parts[0].lower() != "bearer":
            return False
        supplied = parts[1].strip()
        return hmac.compare_digest(
            hashlib.sha256(supplied.encode()).digest(),
            hashlib.sha256(self.hub.management_key().encode()).digest(),
        )

    def management_usage_shim(self, url):
        """Expose registered Idlenet/Silo seats through CLIProxyAPI's /v0/management usage
        endpoints (auth-files, auth-files/models, api-call) without moving OAuth tokens off laptops.
        Strictly requires the management Bearer token; cookies are never accepted."""
        if not self.bearer_management_ok():
            self.send(401, {"error": "unauthorized"})
            return
        if url.path == "/v0/management/auth-files":
            if self.command != "GET":
                self.send(405, {"error": "method not allowed"})
                return
            rel = "auth-files" + (f"?{url.query}" if url.query else "")
            status, ctype, raw = self.hub.proxy_v0(rel)
            if status != 200 or url.query:
                self.send(status, raw, content_type=ctype or "application/json")
                return
            try:
                data = json.loads(raw)
            except ValueError:
                self.send(status, raw, content_type=ctype or "application/json")
                return
            if isinstance(data, dict) and isinstance(data.get("files"), list):
                names = self.hub.store.nicknames()
                files, id_map, used_ids = apply_v0_auth_file_nicknames(data["files"], names)
                files.sort(key=lambda item: (
                    str(item.get("provider") or "") if isinstance(item, dict) else "",
                    natural_sort_key(item.get("id") or item.get("email") or item.get("name") or "") if isinstance(item, dict) else (),
                    str(item.get("name") or "") if isinstance(item, dict) else "",
                ))
                registry = load_registry()
                silo_ids = set()
                if registry:
                    plans = self.hub.store.plan_overrides()
                    existing_auth = {item.get("auth_index") for item in files if isinstance(item, dict) and item.get("auth_index")}
                    for entry in registry:
                        name = entry["hub_auth_name"]
                        sid = "silo:" + name
                        if sid in existing_auth:
                            continue
                        nick = names.get(sid) or names.get(name) or ""
                        plan = plans.get(sid) or silo_plan(entry["provider"], name, entry.get("plan"))
                        record = silo_auth_file(entry, nickname=nick, plan=plan, used_ids=used_ids)
                        files.append(record)
                        silo_ids.add(record["id"])
                data["files"] = files
                with self.hub.lock:
                    self.hub.v0_id_map = id_map
                    self.hub.v0_silo_ids = silo_ids
            self.send(200, data)
            return
        if url.path == "/v0/management/auth-files/models":
            if self.command != "GET":
                self.send(405, {"error": "method not allowed"})
                return
            params = urllib.parse.parse_qs(url.query, keep_blank_values=True)
            name = params.get("name", [""])[0]
            if self.hub.is_v0_silo_id(name):
                self.send(404, {"error": "auth file not found"})
                return
            query = url.query
            if name:
                real_name = self.hub.resolve_v0_auth_id(name)
                if real_name != name:
                    params["name"] = [real_name]
                    query = urllib.parse.urlencode(params, doseq=True)
            rel = "auth-files/models" + (f"?{query}" if query else "")
            status, ctype, raw = self.hub.proxy_v0(rel)
            self.send(status, raw, content_type=ctype or "application/json")
            return
        if url.path == "/v0/management/api-call":
            if self.command != "POST":
                self.send(405, {"error": "method not allowed"})
                return
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > 65536:
                self.send(413, {"error": "Request is too large."})
                return
            raw_body = self.rfile.read(length) if length else b"{}"
            body = json.loads(raw_body or b"{}")
            if not isinstance(body, dict):
                raise ValueError("Expected a JSON object.")
            auth_index = body.get("auth_index")
            if isinstance(auth_index, str) and auth_index.startswith("silo:"):
                entry = silo_entry(auth_index)
                if entry is None:
                    self.send(404, {"error": "auth entry not found"})
                    return
                windows, plan = self.hub.silo_usage_snapshot(entry)
                code, payload = silo_api_call_response(
                    entry["provider"], body.get("url"), windows, plan=plan, method=body.get("method") or "GET",
                )
                self.send(200, {"status_code": code, "body": json.dumps(payload)})
                return
            status, ctype, raw = self.hub.proxy_v0("api-call", data=raw_body, method="POST")
            self.send(status, raw, content_type=ctype or "application/json")
            return

    def api_base(self):
        # Clients reach the proxy on the host this page was opened on, or the first public one.
        host = self.headers.get("Host", "")
        host = host if host in PUBLIC_HOSTS else (PUBLIC_HOSTS or [None])[0]
        return f"https://{host}" if host else CPA_URL

    def client_keys(self, path, url, body):
        query = urllib.parse.parse_qs(url.query)
        key_id = str(body.get("id", "")) if self.command == "POST" else query.get("key", [""])[0]
        if (key_id or path in {"/api/keys/update", "/api/keys/rotate", "/api/keys/delete"}) and not CLIENT_KEY_ID.fullmatch(key_id):
            raise InputError("Unknown client key.")
        try:
            if path == "/api/keys" and self.command == "GET":
                result = self.hub.request("access/client-keys")
                self.send(200, {"keys": [safe_client_key(k) for k in result.get("keys") or []], "base_url": self.api_base()})
            elif path == "/api/keys/options" and self.command == "GET":
                result = self.hub.request("access/client-keys/options")
                self.send(200, {
                    "providers": [str(p) for p in result.get("providers") or []],
                    "accounts": [{"id": str(a.get("id", "")), "provider": str(a.get("provider", "")),
                                  "label": str(a.get("label") or ""), "disabled": bool(a.get("disabled"))}
                                 for a in result.get("accounts") or []],
                    "models": [{"id": str(m.get("id", "")), "providers": [str(p) for p in m.get("providers") or []]}
                               for m in result.get("models") or []]})
            elif path == "/api/keys/usage" and self.command == "GET":
                all_time = query.get("all", [""])[0].lower() in {"1", "true"}
                hours = 2160 if all_time else min(max(int(query.get("hours", ["168"])[0]), 1), 2160)
                params = {"hours": hours}
                if all_time:
                    params["all"] = 1
                if key_id:
                    params["key"] = key_id
                result = self.hub.request("access/client-keys/usage?" + urllib.parse.urlencode(params))
                live = [{"key_id": str(b.get("key_id", "")), "hour": timestamp(b.get("hour")),
                         "provider": str(b.get("provider") or ""), "account": str(b.get("account") or ""),
                         "model": str(b.get("model") or ""),
                         **{k: int(number(b.get(k)) or 0) for k in CLIENT_KEY_USAGE_FIELDS}}
                        for b in result.get("buckets") or []]
                store = self.hub.store
                if all_time:
                    store.save_live_buckets(live)
                    buckets = store.live_buckets(key_id=key_id)
                else:
                    try:
                        store.save_live_buckets(live)
                    except sqlite3.Error:
                        pass  # A failed snapshot write should not hide the current proxy response.
                    buckets = live
                if not key_id:
                    buckets += store.imported_buckets(None if all_time else time.time() - hours * 3600)
                since = timestamp(result.get("since"))
                if all_time:
                    since = min((b["hour"] for b in buckets if b["hour"] is not None), default=since)
                self.send(200, {"since": since, "buckets": self.hub.normalize_usage_buckets(buckets)})
            elif path == "/api/keys/create" and self.command == "POST":
                result = self.hub.request("access/client-keys", client_key_input(body, create=True), "POST")
                self.send(201, {"key": safe_client_key(result["key"]), "secret": client_key_secret(result)})
            elif path == "/api/keys/update" and self.command == "POST":
                result = self.hub.request(f"access/client-keys/{key_id}", client_key_input(body), "PATCH")
                self.send(200, {"key": safe_client_key(result["key"])})
            elif path == "/api/keys/rotate" and self.command == "POST":
                result = self.hub.request(f"access/client-keys/{key_id}/rotate", {}, "POST")
                self.send(200, {"key": safe_client_key(result["key"]), "secret": client_key_secret(result)})
            elif path == "/api/keys/delete" and self.command == "POST":
                self.hub.request(f"access/client-keys/{key_id}", method="DELETE")
                self.send(200, {"status": "ok"})
            else:
                self.send(404, {"error": "Page not found."})
        except ProxyError as exc:
            if exc.status == 404 and b"client key not found" in exc.body:
                self.send(404, {"error": "This key no longer exists. Refresh the page."})
            elif exc.status in (404, 503):
                self.send(502, {"error": "This proxy version has no client keys. Update CLIProxyAPI."})
            elif exc.status == 400:
                self.send(400, {"error": "The proxy refused these settings. Check the model patterns and limit."})
            else:
                raise

    def do_GET(self):
        self.handle_route()

    def do_HEAD(self):
        self.handle_route()

    def do_POST(self):
        self.handle_route()

    def handle_route(self):
        self.renewed_cookie = None
        try:
            self.route()
        except InputError as exc:
            self.send(400, {"error": str(exc)})
        except (ValueError, KeyError, json.JSONDecodeError):
            self.send(400, {"error": "The request could not be completed. Refresh and try again, or check the original panel."})
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception:
            self.send(502, {"error": "Cannot reach the proxy. Check the connection and try again."})


def main():
    os.umask(0o077)
    DATA.mkdir(parents=True, exist_ok=True, mode=0o700)
    hub = Hub(Store(DATA / "quota.sqlite"))
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    server.hub = hub
    threading.Thread(target=hub.collect, daemon=True).start()
    threading.Thread(target=hub.usage_breakdown.warm_loop, args=(hub.store,), daemon=True).start()
    print(f"Dashboard listening on 127.0.0.1:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
