"""Quota-aware Claude routing advisor combining Claude pool and Antigravity Claude & GPT (3p) windows.

Policy A (soonest-reset + auto-start untouched 100% AGY 3p-weekly windows):
- Only routes models supported by Antigravity's native ACP harness (claude-opus-5-5).
- Compares eligible Claude pool accounts (local OAuth + Silo laptop seats) against eligible
  Antigravity Claude & GPT (3p) accounts (personal primary + Silo u1, honoring u1's cap &
  idle-laptop availability).
- Untouched 100% AGY 3p-weekly windows (reset_at is None or ~7d rolling) are prioritized with
  a short probe hold (default 5 min) so one session starts their 7d clock without stampeding.
- Otherwise picks whichever eligible candidate has the soonest weekly reset.
"""
import math
import re
import time

from api_pricing import antigravity_window_group
from quota_readers import number

AGY_ROUTABLE_CLAUDE_MODELS = frozenset({"claude-opus-5-5"})
PROBE_HOLD_SECONDS = 300.0
QUOTA_STALE_SECONDS = 900.0
WEEK_SECONDS = 7 * 86400.0
# Google sometimes reports a rolling reset_at = now + 7d while 3p-weekly is 100% unused.
UNSTARTED_ROLLING_MARGIN = 300.0

_GEMINI_RE = re.compile(r"gemini|imagen?", re.I)
_AGY_CLAUDE_RE = re.compile(r"claude|third.?party|\b3p\b|3p[-:_]", re.I)


def normalize_claude_model(model):
    raw = str(model or "").strip().lower()
    if "/" in raw:
        raw = raw.rsplit("/", 1)[-1]
    return raw


def is_agy_routable_model(model):
    return normalize_claude_model(model) in AGY_ROUTABLE_CLAUDE_MODELS


def is_agy_claude_window(window):
    """Return True when an Antigravity quota window belongs to the Claude & GPT (3p) group."""
    if not isinstance(window, dict):
        return False
    text = f"{window.get('group') or ''} {window.get('id') or ''} {window.get('label') or ''}"
    if _GEMINI_RE.search(text):
        return False
    if _AGY_CLAUDE_RE.search(text):
        return True
    return antigravity_window_group(window.get("id"), window.get("group")) == "3p"


def _window_exhausted(window, now):
    if not isinstance(window, dict):
        return False
    rem = number(window.get("remaining"))
    if rem is None:
        return False
    reset_at = number(window.get("reset_at"))
    return rem <= 0 and (reset_at is None or reset_at > now)


def _fresh_quota(acct, now):
    if acct.get("quota_error"):
        return False
    quota_at = number(acct.get("quota_at"))
    return quota_at is not None and (now - quota_at) <= QUOTA_STALE_SECONDS


def _in_cooldown(acct, now):
    until = number(acct.get("cooldown_until"))
    return until is not None and until > now


def _account_base_eligible(acct, now):
    if not isinstance(acct, dict):
        return False
    if acct.get("disabled") or acct.get("requires_sign_in"):
        return False
    # Personal Antigravity accounts serve via native agy.exe acp rather than CLIProxyAPI's
    # executor (which intentionally hard-blocks non-ACP inference with HTTP 403 and can mark
    # the proxy credential unavailable/cooled). Keep unavailable/cooldown gating for Claude
    # accounts and Silo laptop seats (where unavailable means no idle laptop).
    if acct.get("provider") == "antigravity" and not acct.get("silo"):
        return True
    if acct.get("unavailable"):
        return False
    if _in_cooldown(acct, now):
        return False
    return True


def _claude_windows(acct):
    windows = acct.get("windows") or []
    short, weekly = None, None
    for w in windows:
        if not isinstance(w, dict):
            continue
        wid = str(w.get("id") or "")
        period = number(w.get("period"))
        if wid == "five_hour" or (short is None and period is not None and period <= 86400):
            short = w
        elif wid == "seven_day":
            weekly = w
    if weekly is None:
        for w in windows:
            if not isinstance(w, dict):
                continue
            wid = str(w.get("id") or "")
            period = number(w.get("period"))
            if wid.startswith("weekly_scoped:") or wid.startswith("seven_day_") or wid == "iguana_necktie":
                continue
            if period is not None and abs(period - WEEK_SECONDS) <= 7200:
                weekly = w
                break
    return short, weekly


def _agy_3p_windows(acct):
    short, weekly = None, None
    for w in acct.get("windows") or []:
        if not is_agy_claude_window(w):
            continue
        period = number(w.get("period"))
        wid = str(w.get("id") or "").lower()
        if (period is not None and period <= 86400) or wid.endswith("-5h") or wid.endswith(":5h"):
            if short is None:
                short = w
        elif (period is not None and period > 86400) or "weekly" in wid:
            if weekly is None:
                weekly = w
    return short, weekly


def _agy_3p_cap_blocked(acct, short_w, weekly_w):
    if not acct.get("silo"):
        return False
    if acct.get("capped"):
        return True
    group_caps = acct.get("group_caps") or []
    matched_group = None
    for g in group_caps:
        if not isinstance(g, dict):
            continue
        gname = str(g.get("group") or "")
        if _GEMINI_RE.search(gname):
            continue
        if _AGY_CLAUDE_RE.search(gname) or antigravity_window_group("", gname) == "3p":
            matched_group = g
            break
    if matched_group is not None:
        if matched_group.get("capped"):
            return True
        cap_pct = number(matched_group.get("cap_percent"))
    else:
        cap_pct = number(acct.get("cap_percent"))
    if cap_pct is None:
        return False
    for w in (short_w, weekly_w):
        if w is None:
            continue
        rem = number(w.get("remaining"))
        if rem is not None and (100.0 - rem) >= cap_pct - 1e-6:
            return True
    return False


def _claude_silo_cap_blocked(acct, short_w, weekly_w):
    if not acct.get("silo"):
        return False
    if acct.get("capped"):
        return True
    cap_pct = number(acct.get("cap_percent"))
    if cap_pct is None:
        return False
    for w in (short_w, weekly_w):
        if w is None:
            continue
        rem = number(w.get("remaining"))
        if rem is not None and (100.0 - rem) >= cap_pct - 1e-6:
            return True
    return False


def _agy_account_key(acct):
    if acct.get("silo"):
        name = str(acct.get("name") or "").strip().lower()
        return name or "u1"
    return "primary"


def _is_agy_3p_unstarted(short_w, weekly_w, now):
    if weekly_w is None:
        return False
    w_rem = number(weekly_w.get("remaining"))
    if w_rem is None or w_rem < 99.9:
        return False
    if short_w is not None:
        s_rem = number(short_w.get("remaining"))
        if s_rem is not None and s_rem < 99.9:
            return False
    reset_at = number(weekly_w.get("reset_at"))
    if reset_at is None or reset_at <= now:
        return True
    return (reset_at - now) >= (WEEK_SECONDS - UNSTARTED_ROLLING_MARGIN)


def _prune_probes(probes, now, hold_seconds):
    if not isinstance(probes, dict):
        return
    stale = [k for k, ts in probes.items() if not isinstance(ts, (int, float)) or (now - ts) >= hold_seconds]
    for k in stale:
        probes.pop(k, None)


def _probe_pending(probes, key, now, hold_seconds):
    if not isinstance(probes, dict):
        return False
    ts = probes.get(key)
    return isinstance(ts, (int, float)) and (now - ts) < hold_seconds


def _collect_claude_candidates(accounts, now):
    out = []
    for acct in accounts or ():
        if acct.get("provider") != "claude":
            continue
        if not _account_base_eligible(acct, now):
            continue
        short_w, weekly_w = _claude_windows(acct)
        if _claude_silo_cap_blocked(acct, short_w, weekly_w):
            continue
        if _fresh_quota(acct, now):
            if _window_exhausted(short_w, now) or _window_exhausted(weekly_w, now):
                continue
        reset_at = None
        if weekly_w is not None:
            r = number(weekly_w.get("reset_at"))
            if r is not None and r > now:
                reset_at = r
        rem = number(weekly_w.get("remaining")) if weekly_w is not None else None
        out.append({
            "id": str(acct.get("id") or ""),
            "name": str(acct.get("nickname") or acct.get("name") or acct.get("id") or ""),
            "silo": bool(acct.get("silo")),
            "reset_at": reset_at,
            "remaining": rem,
        })
    out.sort(key=lambda c: (0 if c["reset_at"] is not None else 1, c["reset_at"] if c["reset_at"] is not None else math.inf, c["id"]))
    return out


def _collect_agy_candidates(accounts, now, probes, hold_seconds):
    out = []
    for acct in accounts or ():
        if acct.get("provider") != "antigravity":
            continue
        if not _account_base_eligible(acct, now):
            continue
        short_w, weekly_w = _agy_3p_windows(acct)
        if short_w is None and weekly_w is None:
            continue
        if _agy_3p_cap_blocked(acct, short_w, weekly_w):
            continue
        if _window_exhausted(short_w, now) or _window_exhausted(weekly_w, now):
            continue
        key = _agy_account_key(acct)
        unstarted = _is_agy_3p_unstarted(short_w, weekly_w, now)
        pending_probe = unstarted and _probe_pending(probes, key, now, hold_seconds)
        reset_at = None
        if not unstarted and weekly_w is not None:
            r = number(weekly_w.get("reset_at"))
            if r is not None and r > now:
                reset_at = r
        rem = number(weekly_w.get("remaining")) if weekly_w is not None else (
            number(short_w.get("remaining")) if short_w is not None else None
        )
        # Class order within AGY:
        # 0: unstarted 100% window ready for probe (auto-start rolling 7d clock)
        # 1: active window with known future reset_at (soonest first)
        # 2: unstarted window currently on probe hold or missing reset_at
        if unstarted and not pending_probe:
            rank_class = 0
        elif reset_at is not None:
            rank_class = 1
        else:
            rank_class = 2
        out.append({
            "key": key,
            "id": str(acct.get("id") or ""),
            "silo": bool(acct.get("silo")),
            "unstarted": unstarted,
            "probe_pending": pending_probe,
            "rank_class": rank_class,
            "reset_at": reset_at,
            "remaining": rem,
        })
    # On ties, prefer personal primary before shared u1.
    out.sort(key=lambda c: (
        c["rank_class"],
        c["reset_at"] if c["reset_at"] is not None else math.inf,
        0 if c["key"] == "primary" else 1,
        c["key"],
    ))
    return out


def decide_claude_route(accounts, now=None, model="claude-opus-5-5", probes=None, claim=False,
                        probe_hold=PROBE_HOLD_SECONDS):
    """Decide whether a new Claude session for `model` should run on Claude Code or AGY ACP.

    Returns a JSON-serializable dict with no account emails, credentials, or secrets:
      target: "antigravity" | "claude"
      agy_account: "primary" | "u1" | None  (best eligible AGY account when available)
      agy_order: ["primary", "u1"]          (eligible AGY accounts in preferred order)
      reason: short machine-readable explanation
      model: normalized model name
      claude_reset_at: earliest eligible Claude 7d reset timestamp or None
      agy_reset_at: earliest eligible active AGY 3p-weekly reset timestamp or None
      agy_unstarted: bool (whether best AGY candidate is an untouched 100% window)
    """
    now = float(time.time() if now is None else now)
    norm_model = normalize_claude_model(model) or "claude-opus-5-5"
    _prune_probes(probes, now, probe_hold)

    agy_cands = _collect_agy_candidates(accounts, now, probes, probe_hold)
    claude_cands = _collect_claude_candidates(accounts, now)

    agy_order = []
    for c in agy_cands:
        if c["key"] not in agy_order:
            agy_order.append(c["key"])

    best_agy = agy_cands[0] if agy_cands else None
    best_claude = claude_cands[0] if claude_cands else None

    claude_reset_at = best_claude["reset_at"] if best_claude else None
    agy_reset_at = best_agy["reset_at"] if best_agy else None

    result = {
        "target": "claude",
        "agy_account": best_agy["key"] if best_agy else None,
        "agy_order": agy_order,
        "reason": "claude_soonest_reset",
        "model": norm_model,
        "claude_reset_at": claude_reset_at,
        "agy_reset_at": agy_reset_at,
        "agy_unstarted": bool(best_agy and best_agy["unstarted"]),
        "agy_remaining": best_agy["remaining"] if best_agy else None,
        "claude_remaining": best_claude["remaining"] if best_claude else None,
        "now": now,
    }

    if not is_agy_routable_model(norm_model):
        result["reason"] = "model_not_agy_routable"
        return result

    if best_agy is None:
        result["reason"] = "no_eligible_agy"
        return result

    if best_claude is None:
        result["target"] = "antigravity"
        result["reason"] = "claude_pool_unavailable"
        if claim and best_agy["unstarted"] and isinstance(probes, dict):
            probes[best_agy["key"]] = now
        return result

    # Policy A: auto-start untouched 100% AGY 3p-weekly windows (with probe hold anti-stampede).
    if best_agy["rank_class"] == 0:
        result["target"] = "antigravity"
        result["reason"] = "agy_window_unstarted"
        if claim and isinstance(probes, dict):
            probes[best_agy["key"]] = now
        return result

    # Compare active AGY 3p-weekly reset directly against earliest eligible Claude 7d reset.
    if agy_reset_at is not None:
        if claude_reset_at is None or agy_reset_at < claude_reset_at:
            result["target"] = "antigravity"
            result["reason"] = "agy_soonest_reset"
            return result

    result["target"] = "claude"
    result["reason"] = "agy_probe_pending" if best_agy["probe_pending"] else "claude_soonest_reset"
    return result
