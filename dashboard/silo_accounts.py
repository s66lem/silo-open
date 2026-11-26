"""Silo-capped laptop accounts: plans, quota groups, cap decisions, and the proxy config aliases
that map hub credentials to dashboard accounts."""
from datetime import datetime, timedelta, timezone
import hashlib
import re
import time

from request_inputs import InputError


def parse_silo_deadline(raw):
    """Parse an inclusive local YYYY-MM-DD date or ISO-8601 timestamp into a unix cutoff."""
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    if not text:
        return None
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        try:
            day = datetime.strptime(text, "%Y-%m-%d")
        except ValueError:
            return None
        return (day + timedelta(days=1)).astimezone().timestamp()
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.astimezone()
    return dt.timestamp()


def effective_silo_priority(entry, now=None):
    """Return the desired hub routing priority for a registry entry at now (0 after priority_until)."""
    prio = entry.get("priority")
    if isinstance(prio, bool) or not isinstance(prio, int) or prio == 0:
        return 0
    until = entry.get("priority_until")
    if until is None or str(until).strip() == "":
        return prio
    cutoff = parse_silo_deadline(until)
    if cutoff is None:
        return 0
    current = time.time() if now is None else now
    return prio if current < cutoff else 0


def silo_plan(provider, name, override=None):
    """Human-readable subscription plan label for a Cyclone (laptop-egress) account."""
    if isinstance(override, str) and override.strip():
        return override.strip()
    m = re.search(r"(\d+)$", str(name or ""))
    slot = f" Slot {m.group(1)}" if m else ""
    if provider == "claude":
        return f"Claude Teams{slot}"
    if provider == "codex":
        return f"ChatGPT Business{slot}"
    if provider == "antigravity":
        return "Google AI Ultra"
    return "Cyclone"


def quota_groups(windows):
    """Summarize each quota group using its most used window, with ties in input order."""
    groups = {}
    for window in windows:
        name = window.get("group")
        if not isinstance(name, str) or not name.strip():
            continue
        used = 100 - window["remaining"]
        group = groups.setdefault(name, {"group": name, "used": used, "reset_at": window["reset_at"], "window_ids": []})
        group["window_ids"].append(window["id"])
        if used > group["used"]:
            group.update(used=used, reset_at=window["reset_at"])
    return list(groups.values()) if len(groups) >= 2 else []


def antigravity_group_patterns(group_name, window_ids=(), custom_models=None):
    name = group_name.strip().casefold()
    if custom_models:
        if group_name in custom_models:
            return custom_models[group_name] or None
        for group, patterns in custom_models.items():
            if group.casefold() == name:
                return patterns or None
    ids = [wid.casefold() for wid in window_ids]
    claude, gpt = "claude" in name, "gpt" in name or "openai" in name
    if (claude and gpt) or "third" in name or "other" in name or any("3p" in wid for wid in ids):
        return ["claude-*", "gpt-*"]
    if claude:
        return ["claude-*"]
    if gpt:
        return ["gpt-*"]
    if "image" in name or "imagen" in name:
        return ["*image*", "imagen-*"]
    if "gemini" in name and "flash" in name:
        return ["gemini-*flash*", "tab_flash*", "tab_jump_flash*"]
    if "gemini" in name and "pro" in name:
        return ["gemini-*-pro*", "gemini-4-*", "gemini-3-pro*", "gemini-2.5-pro*"]
    if "gemini" in name or any("gemini" in wid for wid in ids):
        return ["gemini-*", "tab_*"]
    return None


CAP_WINDOWS = ("5h", "weekly")


def clean_cap_window(value):
    """Validate an optional cap window selector ('5h' or 'weekly')."""
    if value is None or value == "":
        return None
    if not isinstance(value, str) or value not in CAP_WINDOWS:
        raise InputError("The quota window must be 5h or weekly.")
    return value


def cap_window_key(window):
    """Classify a quota window dict into '5h', 'weekly', or None."""
    if not isinstance(window, dict):
        return None
    period = window.get("period")
    if not isinstance(period, bool) and isinstance(period, (int, float)) and period > 0:
        if abs(period - 5 * 3600) <= 600:
            return "5h"
        if abs(period - 7 * 86400) <= 7200:
            return "weekly"
    wid = str(window.get("id") or "").strip().casefold()
    label = str(window.get("label") or "").strip().casefold()
    if wid == "five_hour" or wid.endswith((":5h", "-5h", "_5h")) or "5-hour" in label or "5h" in label:
        return "5h"
    if (wid in ("seven_day", "iguana_necktie")
            or wid.startswith(("seven_day_", "weekly_scoped:"))
            or wid.endswith((":7d", "-7d", ":weekly", "-weekly", "_weekly"))
            or "weekly" in label or "7-day" in label):
        return "weekly"
    return None


def silo_group_cap(entry, group, overrides, group_overrides):
    return group_overrides.get(group, overrides.get(entry["hub_auth_name"],
                               entry.get("group_caps", {}).get(group, entry["cap_percent"])))


def silo_window_cap(entry, window_key, overrides=None, account_window_overrides=None, group=None, account_group_overrides=None):
    """Resolve the effective cap % for one Silo seat (and optional group) on a given window."""
    account = entry["hub_auth_name"]
    overrides = overrides or {}
    win_ovr = account_window_overrides or {}
    grp_ovr = account_group_overrides or {}
    if group:
        if window_key and (group, window_key) in win_ovr:
            return win_ovr[(group, window_key)]
        if group in grp_ovr:
            return grp_ovr[group]
        if window_key and ("", window_key) in win_ovr:
            return win_ovr[("", window_key)]
        if account in overrides:
            return overrides[account]
        group_win = entry.get("group_window_caps", {}).get(group, {})
        if window_key and window_key in group_win:
            return group_win[window_key]
        if group in entry.get("group_caps", {}):
            return entry["group_caps"][group]
        if window_key and window_key in entry.get("window_caps", {}):
            return entry["window_caps"][window_key]
        return entry["cap_percent"]
    if window_key and ("", window_key) in win_ovr:
        return win_ovr[("", window_key)]
    if account in overrides:
        return overrides[account]
    if window_key and window_key in entry.get("window_caps", {}):
        return entry["window_caps"][window_key]
    return entry["cap_percent"]


def silo_window_caps(entry, overrides=None, account_window_overrides=None, group=None, account_group_overrides=None):
    return {
        win: silo_window_cap(
            entry, win, overrides, account_window_overrides,
            group=group, account_group_overrides=account_group_overrides,
        )
        for win in CAP_WINDOWS
    }


def _window_cap_value(window, cap_percent, window_caps=None):
    wkey = cap_window_key(window)
    if window_caps and wkey in window_caps:
        val = window_caps[wkey]
        if not isinstance(val, bool) and isinstance(val, (int, float)):
            return float(val)
    if cap_percent is None or isinstance(cap_percent, bool):
        return None
    return float(cap_percent)


def evaluate_window_caps(windows, cap_percent, window_caps=None, used=None, reset_at=None, now=0.0, group=None):
    """Evaluate all windows of a seat (or quota group) against their respective caps.

    Returns {over_cap, reset_at, current_window, hits}. When multiple windows exceed their cap,
    reset_at is the latest future reset among them so the seat stays paused until every capped
    window has cleared."""
    candidates = [
        w for w in (windows or [])
        if (not group or w.get("group") == group)
        and not isinstance(w.get("remaining"), bool)
        and isinstance(w.get("remaining"), (int, float))
    ]
    if candidates:
        hits = []
        for w in candidates:
            used_w = max(0.0, min(100.0, 100.0 - float(w["remaining"])))
            wcap = _window_cap_value(w, cap_percent, window_caps)
            if wcap is not None and round(used_w, 6) >= wcap:
                hits.append((w, used_w, wcap))
        if hits:
            future_resets = [w.get("reset_at") for w, _, _ in hits if w.get("reset_at") is not None and w["reset_at"] > now]
            past_resets = [w.get("reset_at") for w, _, _ in hits if w.get("reset_at") is not None and w["reset_at"] <= now]
            if future_resets:
                eff_reset, current_window = max(future_resets), True
            elif past_resets:
                eff_reset, current_window = max(past_resets), False
            else:
                eff_reset, current_window = None, True
            return {"over_cap": True, "reset_at": eff_reset, "current_window": current_window, "hits": hits}
        current_window = all(w.get("reset_at") is None or w["reset_at"] > now for w in candidates)
        known_resets = [w["reset_at"] for w in candidates if w.get("reset_at") is not None]
        return {"over_cap": False, "reset_at": max(known_resets) if known_resets else None,
                "current_window": current_window, "hits": []}
    over = used is not None and cap_percent is not None and not isinstance(cap_percent, bool) and float(used) >= float(cap_percent)
    return {"over_cap": over, "reset_at": reset_at, "current_window": reset_at is None or reset_at > now, "hits": []}


def silo_group_patterns(entry, groups, markers):
    window_ids = {g["group"]: g["window_ids"] for g in groups}
    return {name: antigravity_group_patterns(name, window_ids.get(name, ()), entry.get("group_models"))
            for name in dict.fromkeys([*window_ids, *markers])}


def cap_decision(used_percent, cap_percent, capped):
    """Pure pause/resume decision for one Silo-capped account.

    capped is whether a Silo cap is currently recorded. used_percent is the latest reading, or
    None when it could not be read. Returns "pause", "unpause", or None (leave as is).
    Resume fails closed: only a valid below-cap reading lifts a cap, never the clock alone (a
    passed reset only forces a fresh read, see remote_usage). Idempotent: it only acts on a
    transition, so a steady state never re-PATCHes."""
    if capped:
        if used_percent is not None and used_percent < cap_percent:
            return "unpause"
        return None
    if used_percent is not None and used_percent >= cap_percent:
        return "pause"
    return None


def format_cap_time(ts):
    dt = datetime.fromtimestamp(ts)
    hour = dt.hour % 12 or 12
    ampm = "AM" if dt.hour < 12 else "PM"
    return f"{dt.strftime('%b')} {dt.day}, {hour}:{dt.minute:02d} {ampm}"


def cap_label(reset_at):
    if not reset_at:
        return "Capped"
    return "Capped until " + format_cap_time(reset_at)


def _fmt_pct(value):
    v = float(value)
    if abs(v - round(v)) < 0.05:
        return f"{int(round(v))}%"
    return f"{v:.1f}%"


def cap_reason(windows, cap_percent, used=None, group=None, unreadable=False, error=None, fallback=None, window_caps=None):
    """Human-readable explanation for why a Silo seat (or quota group) is capped."""
    if unreadable:
        err = str(error or "").strip().rstrip(".")
        return f"Quota unreadable ({err})" if err else "Quota unreadable"
    has_cap = cap_percent is not None and not isinstance(cap_percent, bool)
    if not has_cap and not window_caps:
        return str(fallback or "")
    cap_val = float(cap_percent) if has_cap else None
    candidates = [
        w for w in (windows or [])
        if (not group or w.get("group") == group)
        and not isinstance(w.get("remaining"), bool)
        and isinstance(w.get("remaining"), (int, float))
    ]
    hit = []
    for w in candidates:
        used_w = max(0.0, min(100.0, 100.0 - float(w["remaining"])))
        wcap = _window_cap_value(w, cap_val, window_caps)
        if wcap is not None and round(used_w, 6) >= wcap:
            label = str(w.get("label") or w.get("id") or "Quota")
            if group and label.startswith(f"{group} · "):
                label = label[len(group) + 3:]
            hit.append((used_w, label, wcap))
    if hit:
        hit.sort(key=lambda item: -item[0])
        cap_set = {round(wcap, 6) for _, _, wcap in hit}
        if len(cap_set) == 1:
            parts = [
                f"{_fmt_pct(used_w)} used" if group and label.casefold() == group.casefold() else f"{label} at {_fmt_pct(used_w)}"
                for used_w, label, _ in hit
            ]
            return f"{', '.join(parts)} ({_fmt_pct(hit[0][2])} cap)"
        parts = [
            f"{_fmt_pct(used_w)} used ({_fmt_pct(wcap)} cap)" if group and label.casefold() == group.casefold()
            else f"{label} at {_fmt_pct(used_w)} ({_fmt_pct(wcap)} cap)"
            for used_w, label, wcap in hit
        ]
        return ", ".join(parts)
    if not candidates and cap_val is not None and used is not None and not isinstance(used, bool) and isinstance(used, (int, float)):
        if float(used) >= cap_val - 1e-6:
            return f"Usage at {_fmt_pct(used)} ({_fmt_pct(cap_val)} cap)"
        if fallback:
            return str(fallback)
        return f"Waiting for reset confirmation ({_fmt_pct(cap_val)} cap)"
    if fallback:
        return str(fallback)
    if candidates and used is not None and not isinstance(used, bool) and isinstance(used, (int, float)):
        if cap_val is not None and not window_caps:
            return f"Waiting for reset confirmation ({_fmt_pct(cap_val)} cap)"
        return "Waiting for reset confirmation"
    if cap_val is not None:
        return f"Reached {_fmt_pct(cap_val)} cap"
    return "Reached usage cap"


def clean_cap(value):
    """Owner cap override: a whole percent 1-100, or None/null to clear it."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 100:
        raise InputError("The cap must be a whole number between 1 and 100.")
    return value


def connection_pool_id(group_pool, key_pool):
    if group_pool is None and key_pool is None:
        return ""
    pool = {**(group_pool or {}), **{k: v for k, v in (key_pool or {}).items() if v is not None}}
    enabled = pool.get("enabled")
    max_idle = pool.get("max-idle-conns-per-host")
    return "\0".join(("pool:" + (str(enabled).lower() if isinstance(enabled, bool) else ""),
                      (pool.get("idle-conn-timeout") or "").strip(), str(max_idle) if type(max_idle) is int else ""))


def config_account_aliases(config, registry):
    """Reproduce the proxy's StableIDGenerator from v8 groups. Only display metadata leaves this function."""
    mapping, counts = {}, {}
    if not isinstance(config, dict):
        return mapping
    for family, groups in config.items():
        if family not in {"claude", "codex", "xai", "meta", "gemini", "interactions", "vertex", "openai-compatibility"}:
            continue
        compat = family == "openai-compatibility"
        for group in groups or []:
            if compat and group.get("disabled"):
                continue
            name = (group.get("name") or "").strip()
            kind = "gemini-interactions:apikey" if family == "interactions" else family + ":apikey"
            if compat:
                kind = "openai-compatibility:" + (name.lower() or "openai-compatibility")
            keys = group.get("keys") or group.get("api-key-entries") or []
            for key in keys or ([{}] if compat else []):
                entry = {**group, **{k: v for k, v in key.items() if v is not None}}
                base = entry.get("base-url") or ""
                parts = [entry.get("api-key") or "", base, entry.get("proxy-url") or ""]
                if compat and not keys:
                    parts = [base]
                elif not compat and family != "vertex":
                    headers = entry.get("headers") or {}
                    parts.extend([entry.get("prefix") or "", "".join(f"{k}\0{headers[k]}\0" for k in sorted(headers))])
                pool = connection_pool_id(group.get("connection-pool"), key.get("connection-pool"))
                if pool:
                    parts.append(pool)
                digest = hashlib.sha256("\0".join([kind, *(part.strip() for part in parts)]).encode()).hexdigest()[:12]
                auth_id = f"{kind}:{digest}"
                index = counts.get(auth_id, 0)
                counts[auth_id] = index + 1
                if index:
                    auth_id += f"-{index}"

                label = name or (key.get("prefix") or group.get("prefix") or "").strip()
                if label:
                    silo = registry.get(label.lower())
                    if silo:
                        label = silo["hub_auth_name"]
                        mapping[auth_id] = ("silo:" + label, silo["provider"], label)
                    else:
                        mapping[auth_id] = (label, "openai-compatible" if compat else family, label)
    return mapping


def _iso_utc(ts):
    if ts is None or isinstance(ts, bool) or not isinstance(ts, (int, float)):
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _codex_plan_type(plan):
    text = str(plan or "").lower()
    if "enterprise" in text:
        return "enterprise"
    if "edu" in text:
        return "edu"
    if "pro" in text:
        return "pro"
    if "plus" in text:
        return "plus"
    return "business"


def apply_v0_auth_file_nicknames(files, nicknames):
    """For T3's /v0/management/auth-files view, replace a personal account's id with its dashboard
    nickname and omit email so T3 displays the nickname instead of the generic provider label.
    Returns (updated_files, exposed_id_to_real_id, used_ids)."""
    nicknames = nicknames or {}
    # Reserve original IDs of accounts without nicknames so a nickname can never collide with them.
    reserved = set()
    for item in files:
        if not isinstance(item, dict):
            continue
        orig_id = str(item.get("id") or "")
        file_name = str(item.get("name") or orig_id)
        if not (nicknames.get(file_name) or nicknames.get(orig_id) or "").strip() and orig_id:
            reserved.add(orig_id)
    out, id_map, used_ids = [], {}, set(reserved)
    for item in files:
        if not isinstance(item, dict):
            out.append(item)
            continue
        orig_id = str(item.get("id") or "")
        file_name = str(item.get("name") or orig_id)
        nick = (nicknames.get(file_name) or nicknames.get(orig_id) or "").strip()
        if nick and nick not in used_ids:
            updated = {**item, "id": nick}
            updated.pop("email", None)
            out.append(updated)
            if orig_id:
                id_map[nick] = orig_id
            used_ids.add(nick)
        else:
            out.append(item)
            if orig_id:
                used_ids.add(orig_id)
    return out, id_map, used_ids


def silo_auth_file(entry, nickname=None, plan=None, used_ids=None):
    """Build a virtual /v0/management/auth-files record for a registered Idlenet/Silo seat so
    CLIProxyAPI usage clients (such as T3 Code) can list and probe its cached quota without any
    OAuth token ever leaving the laptop. Omitting email lets T3 display the seat name (e.g. s1, c1,
    u1) instead of the generic provider label."""
    name = entry["hub_auth_name"]
    provider = entry["provider"]
    display = (nickname or "").strip() or name
    record_id = display if (used_ids is None or display not in used_ids) else ("silo:" + name)
    if used_ids is not None:
        used_ids.add(record_id)
    record = {
        "id": record_id,
        "name": "silo:" + name,
        "auth_index": "silo:" + name,
        "provider": provider,
        "disabled": False,
    }
    if provider == "antigravity":
        record["project_id"] = "silo:" + name
    elif provider == "codex":
        record["id_token"] = {"plan_type": _codex_plan_type(plan or entry.get("plan"))}
    return record


def silo_api_call_response(provider, url, windows, plan=None, method="GET"):
    """Translate a Silo seat's cached dashboard quota windows into the upstream provider JSON shape
    expected by /v0/management/api-call usage probes. Returns (status_code, body_dict)."""
    target = str(url or "").lower()
    method_upper = str(method or "GET").upper()
    if provider == "claude":
        if "/api/oauth/usage" not in target or method_upper != "GET":
            return 404, {"error": "unsupported_endpoint"}
        if not windows:
            return 503, {"error": "quota_unavailable"}
        payload = {}
        limits = []
        for w in windows:
            wid = str(w.get("id") or "")
            rem = w.get("remaining")
            if isinstance(rem, bool) or not isinstance(rem, (int, float)):
                continue
            used = round(max(0.0, min(100.0, 100.0 - float(rem))), 3)
            resets_at = _iso_utc(w.get("reset_at"))
            if wid in ("five_hour", "seven_day"):
                payload[wid] = {"utilization": used, "resets_at": resets_at}
            elif wid.startswith("weekly_scoped:"):
                label = str(w.get("label") or wid).removeprefix("Weekly · ").strip() or wid
                limits.append({
                    "kind": "weekly_scoped",
                    "percent": used,
                    "resets_at": resets_at,
                    "scope": {"model": {"display_name": label}},
                })
        if limits:
            payload["limits"] = limits
        if not payload:
            return 503, {"error": "quota_unavailable"}
        return 200, payload

    if provider == "codex":
        if "/rate-limit-reset-credits" in target:
            # Never allow reset-credit consumption on shared Idlenet seats; 404 also omits resetCredits.
            return (400 if "/consume" in target or method_upper != "GET" else 404), {"error": "not_available"}
        if "/wham/usage" not in target or method_upper != "GET":
            return 404, {"error": "unsupported_endpoint"}
        main = [w for w in (windows or [])
                if not str(w.get("id") or "").startswith("code_review")
                and not isinstance(w.get("remaining"), bool)
                and isinstance(w.get("remaining"), (int, float))]
        if not main:
            return 503, {"error": "quota_unavailable"}
        main.sort(key=lambda w: float(w.get("period") or float("inf")))

        def _codex_window(w):
            used = round(max(0.0, min(100.0, 100.0 - float(w["remaining"]))), 3)
            out = {"used_percent": used}
            reset_at = w.get("reset_at")
            if reset_at is not None and not isinstance(reset_at, bool) and isinstance(reset_at, (int, float)):
                out["reset_at"] = int(round(reset_at))
            period = w.get("period")
            if period is not None and not isinstance(period, bool) and isinstance(period, (int, float)) and period > 0:
                out["limit_window_seconds"] = int(round(period))
            return out

        rate_limit = {"primary_window": _codex_window(main[0]),
                      "secondary_window": _codex_window(main[1]) if len(main) > 1 else None}
        return 200, {"plan_type": _codex_plan_type(plan), "rate_limit": rate_limit}

    if provider == "antigravity":
        if "oauth2/v2/userinfo" in target:
            # Returning 404 preserves the seat's display label and avoids fingerprint collisions.
            return 404, {"error": "not_available"}
        if "retrieveuserquotasummary" not in target:
            return 404, {"error": "unsupported_endpoint"}
        if not windows:
            return 503, {"error": "quota_unavailable"}
        grouped = {}
        for w in windows:
            wid = str(w.get("id") or "").strip()
            rem = w.get("remaining")
            if not wid or isinstance(rem, bool) or not isinstance(rem, (int, float)):
                continue
            gname = str(w.get("group") or "Quota").strip() or "Quota"
            bucket = {
                "bucketId": wid,
                "remainingFraction": round(max(0.0, min(1.0, float(rem) / 100.0)), 6),
            }
            period = w.get("period")
            if period == 5 * 3600 or wid.endswith("-5h") or wid.endswith(":5h"):
                bucket["window"] = "5h"
            elif period == 7 * 86400 or wid.endswith("-weekly") or wid.endswith(":weekly"):
                bucket["window"] = "weekly"
            label = str(w.get("label") or "").strip()
            if label:
                bucket["displayName"] = label
            reset_iso = _iso_utc(w.get("reset_at"))
            if reset_iso:
                bucket["resetTime"] = reset_iso
            grouped.setdefault(gname, []).append(bucket)
        if not grouped:
            return 503, {"error": "quota_unavailable"}
        return 200, {"groups": [{"displayName": g, "buckets": bs} for g, bs in grouped.items()]}

    return 404, {"error": "unsupported_provider"}
