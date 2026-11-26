#!/usr/bin/env python3
"""Backfill the dashboard's history with usage that did not go through Silo, for hub accounts only.

Reads (never writes) local CLI session logs and the muse-dash usage file:
  * Claude Code transcripts   <home>/projects/**/*.jsonl     -> token buckets
  * Codex sessions            <home>/sessions/**/*.jsonl     -> token buckets + 5-hour / weekly quota samples
  * muse-dash usage.json      accounts[*].history            -> quota samples
  * T3's native Antigravity   <home>/.t3/userdata/providers/antigravity/*/antigravity-acp/brain/*/
                              .system_generated/logs/transcript.jsonl -> token buckets
    (it talks to Google directly, so it never reaches Silo; its quota is already live on the dashboard)

Claude and Codex homes are pre-Silo history: once a home is pointed at Silo, re-importing it would count
its usage twice. Antigravity is meant to be re-run on a schedule with `--sources antigravity`, which
replaces only the Antigravity rows.

A home or row is imported only when its login email matches a hub account of the same provider
(the hub is read from the proxy's credentials list, or from --accounts). Anything that cannot be
matched with certainty is skipped and listed.

Imported rows go to their own tables (samples_imported, tokens_imported) that the dashboard reads
alongside live data, so nothing live is ever overwritten and `--remove` undoes the import.
Each run replaces the previous import completely, so re-running is safe.

  python import_history.py --db quota.sqlite --dry-run
  python import_history.py --db quota.sqlite --credentials credentials.json --proxy-url http://127.0.0.1:8317
"""
import argparse
import base64
import json
import os
import re
import sqlite3
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

IMPORTED = "imported"  # key_id the Tokens page shows as "Before Silo"
HOUR = 3600
QUOTA_IDS = {  # window length in seconds -> (provider -> metric id), as the dashboard names them
    "codex": {5 * HOUR: "rate_limit:5h", 7 * 86400: "rate_limit:7d"},
    "claude": {5 * HOUR: "five_hour", 7 * 86400: "seven_day"},
}
# muse-dash usage.json account names that are the owner's own local logins. The login behind each
# is confirmed from the home's own login email, never guessed from the label.
DASH_ACCOUNTS = {"MAIN": ("claude", ".claude"), "GPT1": ("codex", ".codex"), "GPT2": ("codex", ".codex2")}
AGY_HOMES = ".t3/userdata/providers/antigravity/*/antigravity-acp"
SOURCES = ("claude", "codex", "antigravity")


def iso(value):
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def email_from_name(name):
    """Hub credential files are named <provider>-[<hex id>-]<email>[-<plan>].json."""
    stem = re.sub(r"\.json$", "", name or "")
    stem = re.sub(r"^[a-z]+-(?:[0-9a-f]{6,}-)?", "", stem)
    stem = re.sub(r"-(plus|pro|prolite|team|free|go|enterprise|max)$", "", stem)
    m = re.fullmatch(r"[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]+", stem)
    return stem.lower() if m else None


# ---- who is on the hub ------------------------------------------------------------------------
def hub_accounts(files):
    """(provider, email) -> {auth_index, name} for every hub credential with a known email."""
    out = {}
    for f in files:
        email = (f.get("email") or email_from_name(f.get("name")) or "").lower()
        if f.get("provider") and email and f.get("auth_index") and f.get("name"):
            out[(f["provider"], email)] = {"auth_index": f["auth_index"], "name": f["name"]}
    return out


def fetch_hub_files(proxy_url, credentials):
    key = json.load(open(credentials, encoding="utf-8"))["management_key"]
    req = urllib.request.Request(proxy_url.rstrip("/") + "/v8/management/credentials",
                                 headers={"Authorization": "Bearer " + key})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.load(r).get("files", [])


# ---- which home belongs to which login --------------------------------------------------------
def claude_home_email(home):
    try:
        data = json.load(open(Path(home) / ".claude.json", encoding="utf-8"))
        return (data.get("oauthAccount") or {}).get("emailAddress", "").lower() or None
    except (OSError, ValueError):
        return None


def codex_home_email(home):
    try:
        token = json.load(open(Path(home) / "auth.json", encoding="utf-8"))["tokens"]["id_token"]
        payload = token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        return (claims.get("email") or "").lower() or None
    except (OSError, ValueError, KeyError, IndexError):
        return None


def agy_home_email(home):
    try:
        return (json.load(open(Path(home) / "antigravity-oauth-token", encoding="utf-8")).get("id_token_email") or "").lower() or None
    except (OSError, ValueError, AttributeError):
        return None


def discover_homes(user_home):
    """[(provider, home path, email or None)] for every Claude/Codex/Antigravity home under the user's home."""
    homes = [("antigravity", p, agy_home_email(p))
             for p in sorted(Path(user_home).glob(AGY_HOMES)) if p.is_dir()]
    for p in sorted(Path(user_home).glob(".claude*")):
        if p.is_dir() and (p / "projects").is_dir():
            homes.append(("claude", p, claude_home_email(p)))
    for p in sorted(Path(user_home).glob(".codex*")):
        if p.is_dir():
            homes.append(("codex", p, codex_home_email(p)))
    return homes


# ---- parsing ----------------------------------------------------------------------------------
def claude_usage(path, cutoff, seen):
    """Yield (message id, ts, model, uncached input, output, cache read, cache write), each id once.
    Claude Code streams a message into several lines with the same id; the largest figures win."""
    best = {}
    with open(path, "rb") as fh:
        for raw in fh:
            if b'"usage"' not in raw or b'"assistant"' not in raw:
                continue
            try:
                row = json.loads(raw)
            except ValueError:
                continue
            msg = row.get("message")
            if row.get("type") != "assistant" or not isinstance(msg, dict) or not isinstance(msg.get("usage"), dict):
                continue
            mid, model, u = msg.get("id"), msg.get("model") or "", msg["usage"]
            ts = iso(row.get("timestamp"))
            if not mid or ts is None or ts < cutoff or model.startswith("<"):
                continue
            vals = [int(u.get(k) or 0) for k in ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")]
            cur = best.get(mid)
            if cur:
                vals = [max(a, b) for a, b in zip(vals, cur[3:])]
                ts = min(ts, cur[1])
            best[mid] = (mid, ts, model, *vals)
    for mid, rec in best.items():
        if mid not in seen:
            seen.add(mid)
            yield rec


def codex_events(path, cutoff, seen):
    """Yield ('tokens', ts, model, input incl. cached, output, cached, cache write) and
    ('quota', ts, primary, secondary) from one Codex session file, each event once."""
    model = ""
    with open(path, "rb") as fh:
        for raw in fh:
            if b'"turn_context"' in raw:
                try:
                    model = (json.loads(raw).get("payload") or {}).get("model") or model
                except ValueError:
                    pass
                continue
            if b'"token_count"' not in raw:
                continue
            try:
                row = json.loads(raw)
            except ValueError:
                continue
            p = row.get("payload") or {}
            ts = iso(row.get("timestamp"))
            if row.get("type") != "event_msg" or p.get("type") != "token_count" or ts is None or ts < cutoff:
                continue
            info = p.get("info") or {}
            total, last = info.get("total_token_usage"), info.get("last_token_usage")
            if isinstance(total, dict) and isinstance(last, dict):
                key = (row.get("timestamp"), total.get("input_tokens"), total.get("output_tokens"), total.get("total_tokens"))
                if key not in seen:
                    seen.add(key)
                    yield ("tokens", ts, model or "codex", int(last.get("input_tokens") or 0), int(last.get("output_tokens") or 0),
                           int(last.get("cached_input_tokens") or 0), int(last.get("cache_write_input_tokens") or 0))
            limits = p.get("rate_limits")
            if isinstance(limits, dict) and (limits.get("limit_id") in (None, "codex")):
                yield ("quota", ts, limits.get("primary"), limits.get("secondary"))


def agy_usage(path, cutoff):
    """Yield (ts, model, input incl. cache reads, output, cache read) for each model response in one
    Antigravity transcript, each step once. Antigravity reports input without the cached part."""
    steps = set()
    with open(path, "rb") as fh:
        for raw in fh:
            if b'"input_tokens"' not in raw:
                continue
            try:
                row = json.loads(raw)
            except ValueError:
                continue
            ts = iso(row.get("created_at"))
            if row.get("source") != "MODEL" or ts is None or ts < cutoff or row.get("step_index") in steps:
                continue
            steps.add(row.get("step_index"))
            read = int(row.get("cache_read_tokens") or 0)
            yield ts, row.get("model") or "antigravity", int(row.get("input_tokens") or 0) + read, int(row.get("output_tokens") or 0), read


def add_bucket(buckets, ts, provider, account, model, uncached_or_input, output, read, write):
    hour = int(ts // HOUR * HOUR)
    b = buckets.setdefault((hour, provider, account, model), [0, 0, 0, 0, 0])
    b[0] += 1
    b[1] += uncached_or_input
    b[2] += output
    b[3] += read
    b[4] += write


def window_sample(provider, ts, win):
    """A rate-limit window as a quota sample row, or None when it is not a plain percentage window."""
    if not isinstance(win, dict) or win.get("used_percent") is None or not win.get("window_minutes"):
        return None
    period = float(win["window_minutes"]) * 60
    metric = QUOTA_IDS.get(provider, {}).get(int(period))
    if not metric:
        return None
    reset = win.get("resets_at")
    return (ts, metric, round(100 - float(win["used_percent"]), 2), float(reset) if reset else None, period)


def thin(rows):
    """One sample per minute per window (the last one in it), keeping each exact timestamp."""
    last = {}
    for r in sorted(rows, key=lambda r: (r[0], r[1])):
        last[(r[1], int(r[0] // 60))] = r
    return sorted(last.values())


# ---- the import -------------------------------------------------------------------------------
def collect(user_home, hub, dash_usage, days, now=None, sources=SOURCES):
    """-> (token buckets, quota rows, skipped) for the providers in sources. Pure reading; writes nothing."""
    now = now or time.time()
    cutoff = now - days * 86400
    buckets, quota, skipped = {}, {}, []
    seen_claude, seen_codex = set(), set()
    for provider, home, email in discover_homes(user_home):
        if provider not in sources:
            continue
        label = f"{home.name} ({provider})"
        acct = hub.get((provider, email)) if email else None
        if not acct:
            skipped.append(f"{label}: login {email or 'unknown'} is not a hub account")
            continue
        name = acct["name"]
        if provider == "antigravity":
            for path in sorted((home / "brain").glob("*/.system_generated/logs/transcript.jsonl")):
                if path.stat().st_mtime >= cutoff:
                    for ts, model, inp, out, read in agy_usage(path, cutoff):
                        add_bucket(buckets, ts, "antigravity", name, model, inp, out, read, 0)
        elif provider == "claude":
            for path in files_since(home / "projects", cutoff):
                for _mid, ts, model, inp, out, read, write in claude_usage(path, cutoff, seen_claude):
                    add_bucket(buckets, ts, "claude", name, model, inp, out, read, write)
        else:
            rows = []
            for path in files_since(home / "sessions", cutoff) + files_since(home / "archived_sessions", cutoff):
                for ev in codex_events(path, cutoff, seen_codex):
                    if ev[0] == "tokens":
                        _k, ts, model, inp, out, cached, write = ev
                        add_bucket(buckets, ts, "codex", name, model, inp, out, cached, write)
                    else:
                        for win in (ev[2], ev[3]):
                            row = window_sample("codex", ev[1], win)
                            if row:
                                rows.append(row)
            quota.setdefault(acct["auth_index"], ("codex", []))[1].extend(rows)
    for key, (provider, home_name) in DASH_ACCOUNTS.items():
        entry = (dash_usage or {}).get("accounts", {}).get(key)
        if provider not in sources or not entry or not entry.get("history"):
            continue
        email = {"claude": claude_home_email, "codex": codex_home_email}[provider](Path(user_home) / home_name)
        acct = hub.get((provider, email)) if email else None
        if not acct:
            skipped.append(f"usage.json {key}: login {email or 'unknown'} is not a hub account")
            continue
        rows = []
        for point in entry["history"]:
            if len(point) < 3 or point[0] < cutoff:
                continue
            for pct, period in ((point[1], 5 * HOUR), (point[2], 7 * 86400)):
                if pct is not None:
                    rows.append((float(point[0]), QUOTA_IDS[provider][period], round(100 - float(pct), 2), None, float(period)))
        quota.setdefault(acct["auth_index"], (provider, []))[1].extend(rows)
    quota = {k: (p, thin(rows)) for k, (p, rows) in quota.items()}
    return buckets, quota, skipped


def files_since(root, cutoff):
    root = Path(root)
    if not root.is_dir():
        return []
    return sorted(p for p in root.rglob("*.jsonl") if p.stat().st_mtime >= cutoff)


def summarize(buckets, quota, hub):
    by_index = {v["auth_index"]: (k[1], k[0]) for k, v in hub.items()}
    lines = []
    totals = {}
    for (hour, provider, account, model), b in buckets.items():
        t = totals.setdefault(account, {"provider": provider, "first": hour, "last": hour, "requests": 0, "input": 0, "output": 0, "read": 0, "write": 0})
        t["first"], t["last"] = min(t["first"], hour), max(t["last"], hour)
        t["requests"] += b[0]
        t["input"] += b[1]
        t["output"] += b[2]
        t["read"] += b[3]
        t["write"] += b[4]
    fmt = lambda ts: datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")
    for account, t in sorted(totals.items()):
        lines.append(f"tokens  {account}: {fmt(t['first'])} .. {fmt(t['last'])}, {t['requests']} requests, input {t['input']:,}, "
                     f"output {t['output']:,}, cache read {t['read']:,}, cache write {t['write']:,}")
    for index, (provider, rows) in sorted(quota.items()):
        email = by_index.get(index, ("?", "?"))[0]
        for metric in sorted({r[1] for r in rows}):
            mine = [r for r in rows if r[1] == metric]
            lines.append(f"quota   {provider} {email} {metric}: {fmt(mine[0][0])} .. {fmt(mine[-1][0])}, {len(mine)} samples")
    return lines


def write(db_path, buckets, quota, hub, sources=SOURCES):
    """Replace the imported rows of the providers in sources; other providers' rows stay."""
    from server import Store

    Store(db_path)  # creates the tables (CREATE IF NOT EXISTS), like the dashboard itself
    con = sqlite3.connect(db_path, timeout=30)
    marks = ",".join("?" * len(sources))
    try:
        with con:
            con.execute(f"DELETE FROM samples_imported WHERE provider IN ({marks})", tuple(sources))
            con.execute(f"DELETE FROM tokens_imported WHERE provider IN ({marks})", tuple(sources))
            for index, (provider, rows) in quota.items():
                con.executemany("INSERT OR REPLACE INTO samples_imported VALUES (?,?,?,?,?,?,?)",
                                [(ts, index, provider, metric, remaining, reset, period) for ts, metric, remaining, reset, period in rows])
            con.executemany("INSERT OR REPLACE INTO tokens_imported VALUES (?,?,?,?,?,?,?,?,?,?)",
                            [(hour, provider, account, model, b[0], 0, b[1], b[2], b[3], b[4])
                             for (hour, provider, account, model), b in buckets.items()])
    finally:
        con.close()


def remove(db_path):
    con = sqlite3.connect(db_path, timeout=30)
    try:
        with con:
            for table in ("samples_imported", "tokens_imported"):
                try:
                    con.execute(f"DELETE FROM {table}")
                except sqlite3.OperationalError:
                    pass
    finally:
        con.close()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", required=True, help="the dashboard's quota.sqlite")
    ap.add_argument("--home", default=str(Path.home()), help="folder holding the .claude*/.codex* homes")
    ap.add_argument("--usage", help="muse-dash usage.json")
    ap.add_argument("--accounts", help="JSON list of hub credentials (default: read from the proxy)")
    ap.add_argument("--proxy-url", default="http://127.0.0.1:8317")
    ap.add_argument("--credentials", help="credentials.json with management_key, to read the hub accounts")
    ap.add_argument("--days", type=int, default=30, help="only history this recent (the dashboard keeps 30 days)")
    ap.add_argument("--sources", default=",".join(SOURCES),
                    help="comma-separated providers to (re)import; only their imported rows are replaced")
    ap.add_argument("--dry-run", action="store_true", help="print what would be imported and change nothing")
    ap.add_argument("--remove", action="store_true", help="delete every imported row")
    a = ap.parse_args(argv)
    if a.remove:
        remove(a.db)
        print("imported rows removed")
        return 0
    if a.accounts:
        files = json.load(open(a.accounts, encoding="utf-8"))
    elif a.credentials:
        files = fetch_hub_files(a.proxy_url, a.credentials)
    else:
        ap.error("give --accounts or --credentials to learn which accounts are on the hub")
    sources = tuple(s.strip() for s in a.sources.split(",") if s.strip())
    unknown = set(sources) - set(SOURCES)
    if not sources or unknown:
        ap.error(f"--sources takes some of {', '.join(SOURCES)}")
    hub = hub_accounts(files)
    dash = json.load(open(a.usage, encoding="utf-8")) if a.usage else None
    buckets, quota, skipped = collect(a.home, hub, dash, a.days, sources=sources)
    for line in summarize(buckets, quota, hub):
        print(line)
    for line in skipped:
        print("skipped", line)
    if a.dry_run:
        print("dry run: nothing written")
        return 0
    write(a.db, buckets, quota, hub, sources)
    print(f"imported {len(buckets)} hourly token buckets and {sum(len(r) for _, r in quota.values())} quota samples")
    return 0


if __name__ == "__main__":
    sys.exit(main())
