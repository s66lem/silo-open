"""Provider quota readers: turn each provider's usage, plan and reset answers into dashboard windows,
and pick which accounts the proxy routes to next."""
from datetime import datetime
import math
import re
import time


def timestamp(value):
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError, AttributeError):
        return None


def number(value):
    try:
        value = float(value)
        return value if math.isfinite(value) else None
    except (TypeError, ValueError):
        return None


def window(key, label, used=None, remaining=None, reset=None, period=None):
    fraction = number(remaining)
    used = number(used)
    if fraction is None and used is not None:
        fraction = 1 - used / 100
    if fraction is None:
        return None
    return {"id": key, "label": label, "remaining": round(max(0, min(1, fraction)) * 100, 3),
            "reset_at": timestamp(reset), "period": number(period)}


def codex_window_key(group, slot, period):
    # Plans put different limits in the same slot (Plus: 5-hour primary, weekly secondary;
    # Pro: weekly primary only), so a window is keyed by its length, not its slot.
    if not period:
        return f"{group}:{slot}"
    return f"{group}:{period / 86400:g}d" if period >= 86400 else f"{group}:{period / 3600:g}h"


def codex_window_label(period):
    if not period:
        return "Usage limit"
    if period == 7 * 86400:
        return "Weekly limit"
    return f"{period / 86400:g}-day limit" if period >= 86400 else f"{period / 3600:g}-hour limit"


def parse_codex(data):
    windows = []
    for group, title in [("rate_limit", ""), ("code_review_rate_limit", "Code review · ")]:
        for slot in ["primary_window", "secondary_window"]:
            value = (data.get(group) or {}).get(slot)
            if not isinstance(value, dict):
                continue
            period = number(value.get("limit_window_seconds"))
            key = codex_window_key(group, slot, period)
            if any(w["id"] == key for w in windows):
                key = f"{group}:{slot}"
            item = window(key, title + codex_window_label(period), used=value.get("used_percent"),
                          reset=value.get("reset_at"), period=period)
            if item:
                windows.append(item)
    windows.sort(key=lambda w: (w["id"].startswith("code_review"), w["period"] or math.inf))
    return {"plan": str(data.get("plan_type") or "Unknown"), "windows": windows}


ANTIGRAVITY_WINDOWS = {"5h": ("5-hour limit", 5 * 3600), "weekly": ("Weekly limit", 7 * 86400)}


def parse_antigravity(data):
    # retrieveUserQuotaSummary: models in a group share one 5-hour and one weekly limit.
    windows = []
    for n, group in enumerate(data.get("groups") or [], 1):
        name = str(group.get("displayName") or f"Group {n}")
        name = re.sub(r"\s+models$", "", name, flags=re.I).replace(" and ", " & ")
        # Shortest window first, like Claude and Codex (the API lists weekly first).
        buckets = sorted(group.get("buckets") or [], key=lambda b: ANTIGRAVITY_WINDOWS.get(b.get("window"), ("", math.inf))[1])
        for bucket in buckets:
            label, period = ANTIGRAVITY_WINDOWS.get(bucket.get("window"), (
                re.sub(r"\s+remaining$", "", str(bucket.get("displayName") or "Limit"), flags=re.I), None))
            item = window(bucket.get("bucketId") or f"{name}:{bucket.get('window')}", f"{name} · {label}",
                          remaining=bucket.get("remainingFraction"), reset=bucket.get("resetTime"), period=period)
            if item:
                windows.append({**item, "group": name})
    return {"plan": "Antigravity", "windows": windows}


DEVIN_WINDOWS = (
    ("daily", "Daily limit", "daily_quota_remaining_percent", "daily_quota_reset_at", 86400),
    ("weekly", "Weekly limit", "weekly_quota_remaining_percent", "weekly_quota_reset_at", 7 * 86400),
)


def devin_percent(value):
    # A present but unreadable value fails the check, so the last good reading is kept.
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise ValueError("Devin returned an unreadable quota.")
    raw = value.strip()[:-1].strip() if isinstance(value, str) and value.strip().endswith("%") else value
    parsed = number(raw)
    if parsed is None:
        raise ValueError("Devin returned an unreadable quota.")
    return parsed


def parse_xai(data):
    config = data.get("config", data) if isinstance(data, dict) else None
    if not isinstance(config, dict):
        raise ValueError("Grok returned unreadable credit usage.")
    current = config.get("currentPeriod") or config.get("current_period")
    current = current if isinstance(current, dict) else {}
    kind = str(current.get("type") or "").lower()
    period = 7 * 86400 if "weekly" in kind else None
    reset = current.get("end") or config.get("billingPeriodEnd") or config.get("billing_period_end")
    label = "Weekly credits" if period else "Credits"
    rows = [("credits", label, config.get("creditUsagePercent", config.get("credit_usage_percent")))]
    products = config.get("productUsage") or config.get("product_usage")
    if isinstance(products, list):
        for item in products:
            if isinstance(item, dict) and isinstance(item.get("product"), str):
                name = item["product"].strip()
                if name:
                    rows.append((f"product:{name.lower()}", name, item.get("usagePercent", item.get("usage_percent"))))
    windows = {}
    for key, label, used in rows:
        if isinstance(used, bool):
            continue
        result = window(key, label, used=used, reset=reset, period=period)
        if result:
            windows[key] = result
    return {"plan": "xAI", "windows": list(windows.values())}


def parse_xai_plan(data):
    if not isinstance(data, dict):
        return None
    tier = data.get("subscriptionTier", data.get("subscription_tier"))
    if not isinstance(tier, str):
        return None
    key = re.sub(r"[\s_-]+", "", tier.lower())
    return {
        "free": "Free", "grokpro": "SuperGrok", "supergrok": "SuperGrok", "supergroklite": "SuperGrok Lite",
        "supergrokplus": "SuperGrok Plus", "supergrokpro": "SuperGrok Heavy", "supergrokheavy": "SuperGrok Heavy",
        "xbasic": "X Basic", "xpremium": "X Premium", "xpremiumplus": "X Premium+", "xpremium+": "X Premium+",
    }.get(key)


def parse_devin(data):
    # CLIProxyAPI's Devin refresh populates auth.quota.signals from GetUserStatus.
    if not isinstance(data, dict):
        return {"plan": "Devin", "windows": []}
    quota = data.get("quota") if isinstance(data.get("quota"), dict) else {}
    signals = quota.get("signals") if isinstance(quota.get("signals"), dict) else (
        data.get("signals") if isinstance(data.get("signals"), dict) else {}
    )
    windows = []
    for key, label, pct_key, reset_key, period in DEVIN_WINDOWS:
        pct = devin_percent(signals.get(pct_key))
        if pct is None:
            continue
        item = window(key, label, remaining=pct / 100, reset=signals.get(reset_key), period=period)
        if item:
            windows.append(item)
    plan = str(signals.get("plan") or "").strip() or "Devin"
    result = {"plan": plan, "windows": windows}
    started, until = timestamp(signals.get("plan_start")), timestamp(signals.get("plan_end"))
    if started or until:
        result["profile"] = {"subscription_started": started, "subscription_until": until}
    return result


def devin_observed(raw):
    """Best-effort last observation already carried on a Devin credential from GET credentials."""
    if not isinstance(raw, dict) or raw.get("provider") != "devin":
        return None
    try:
        parsed = parse_devin(raw)
    except ValueError:
        return None
    if not parsed["windows"]:
        return None
    parsed["observed_at"] = timestamp((raw.get("quota") or {}).get("observed_at"))
    return parsed


CLAUDE_WINDOWS = {"five_hour": ("5-hour limit", 5 * 3600), "seven_day": ("Weekly limit", 7 * 86400)}
# Per-model weekly windows (seven_day_opus, seven_day_sonnet, ...) are read generically so a new
# model's limit shows up without a code change. OAuth-app usage is not a model limit.
CLAUDE_MODEL_WINDOW = re.compile(r"seven_day_([a-z0-9_]+)")
CLAUDE_SKIPPED_WINDOWS = {"seven_day_oauth_apps"}


def claude_used(value):
    # A present but unreadable value fails the check, so the last good reading is kept.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("Claude returned an unreadable quota.")
    return value


def parse_claude(data):
    # Claude Code's /api/oauth/usage: utilization is percent used; null windows don't apply.
    windows = []
    model_keys = sorted(k for k in data if CLAUDE_MODEL_WINDOW.fullmatch(k) and k not in CLAUDE_SKIPPED_WINDOWS)
    for key in [*CLAUDE_WINDOWS, *model_keys]:
        value = data.get(key)
        if not isinstance(value, dict) or value.get("utilization") is None:
            continue
        label, period = CLAUDE_WINDOWS.get(key) or (
            "Weekly · " + CLAUDE_MODEL_WINDOW.fullmatch(key)[1].replace("_", " ").title(), 7 * 86400)
        windows.append(window(key, label, used=claude_used(value["utilization"]), reset=value.get("resets_at"), period=period))
    # Newer models (Fable 5) report their weekly limit in `limits` as a model-scoped entry.
    scoped = {}
    for limit in data.get("limits") or []:
        name = ((((limit or {}).get("scope") or {}).get("model") or {}).get("display_name") or "").strip()
        if limit.get("kind") != "weekly_scoped" or not name or limit.get("percent") is None:
            continue
        if name not in scoped or limit.get("is_active") is True:
            scoped[name] = limit
    for name, limit in scoped.items():
        key = "weekly_scoped:" + re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
        windows.append(window(key, f"Weekly · {name}", used=claude_used(limit["percent"]),
                              reset=limit.get("resets_at"), period=7 * 86400))
    # Older responses carried Fable under its codename; with dollar fields it is cloud credits instead.
    fable = data.get("iguana_necktie")
    if (isinstance(fable, dict) and fable.get("utilization") is not None and not scoped
            and all(fable.get(k) is None for k in ("limit_dollars", "used_dollars", "remaining_dollars"))):
        windows.append(window("iguana_necktie", "Weekly · Fable 5", used=claude_used(fable["utilization"]),
                              reset=fable.get("resets_at"), period=7 * 86400))
    result = {"plan": "Claude", "windows": windows}
    resets = parse_claude_resets(data.get("cedar_ember"))
    if resets is not None:
        result["resets"] = resets
    return result


CLAUDE_SEATS = {"standard": "Standard", "premium": "Premium", "tier_1": "Premium"}


def parse_claude_plan(profile):
    # /api/oauth/profile: the organization says which plan, and for Team/Enterprise which seat.
    org, account = (profile or {}).get("organization") or {}, (profile or {}).get("account") or {}
    kind, seat = str(org.get("organization_type") or ""), str(org.get("seat_tier") or "")
    if kind in {"claude_team", "claude_enterprise"}:
        # Anthropic reports the Premium seat as tier_1; name seats the way the pricing page does.
        seat = re.sub(r"^(team|enterprise)_", "", seat)
        seat = CLAUDE_SEATS.get(seat, seat.replace("_", " ").title())
        name = "Team" if kind == "claude_team" else "Enterprise"
        return f"{name} · {seat}" if seat else name
    if kind == "claude_max" or account.get("has_claude_max"):
        size = re.search(r"(\d+)x", str(org.get("rate_limit_tier") or ""))
        return f"Max {size[1]}x" if size else "Max"
    if kind == "claude_pro" or account.get("has_claude_pro"):
        return "Pro"
    return None


BILLING_TYPES = {"stripe_subscription": "Web (Stripe)", "apple_subscription": "Apple (App Store)",
                 "google_play_subscription": "Google Play", "enterprise": "Enterprise invoice", "invoice": "Invoice"}


def parse_claude_profile(profile):
    """The subscription facts /api/oauth/profile reports. Only parsed scalars, never raw bodies."""
    org, account = (profile or {}).get("organization") or {}, (profile or {}).get("account") or {}
    if not org and not account:
        return None
    billing = str(org.get("billing_type") or "")
    return {"org_name": str(org.get("name") or "") or None, "org_type": str(org.get("organization_type") or "") or None,
            "seat": str(org.get("seat_tier") or "") or None, "rate_limit_tier": str(org.get("rate_limit_tier") or "") or None,
            "billing": (BILLING_TYPES.get(billing) or billing.replace("_", " ").capitalize()) if billing else None,
            "subscription_status": str(org.get("subscription_status") or "") or None,
            "subscription_started": timestamp(org.get("subscription_created_at")),
            "extra_usage": org.get("has_extra_usage_enabled") if isinstance(org.get("has_extra_usage_enabled"), bool) else None,
            "trial_ends": timestamp(org.get("claude_code_trial_ends_at")),
            "account_created": timestamp(account.get("created_at"))}


def parse_codex_claims(claims):
    """Subscription facts from the credential's id_token claims (already parsed by the proxy)."""
    claims = claims if isinstance(claims, dict) else {}
    orgs = claims.get("organizations")
    title = next((o.get("title") for o in orgs if isinstance(o, dict) and o.get("title")), None) if isinstance(orgs, list) else None
    return {"plan_type": str(claims.get("plan_type") or "") or None, "org_name": str(title) if title else None,
            "subscription_started": timestamp(claims.get("chatgpt_subscription_active_start")),
            "subscription_until": timestamp(claims.get("chatgpt_subscription_active_until")),
            "subscription_checked": timestamp(claims.get("chatgpt_subscription_last_checked"))}


def account_detail(raw, quota=None):
    """Everything the account page shows beyond the card: parsed fields only, never tokens."""
    detail = {"file": str(raw.get("name") or "") or None, "added": timestamp(raw.get("created_at")) or timestamp(raw.get("modtime")),
              "signed_in": timestamp(raw.get("adopted_at")), "provider_fields": {},
              "priority": raw["priority"] if isinstance(raw.get("priority"), int) and not isinstance(raw.get("priority"), bool) else None}
    if raw.get("provider") == "codex":
        detail["provider_fields"] = parse_codex_claims(raw.get("id_token"))
    elif raw.get("provider") in {"claude", "devin"}:
        detail["provider_fields"] = (quota or {}).get("profile") or {}
    return detail


def parse_codex_resets(data, now=None):
    now = time.time() if now is None else now
    credits = sorted((c for c in data.get("credits") or [] if isinstance(c, dict)
                      and c.get("reset_type") == "codex_rate_limits" and c.get("status") == "available"
                      and c.get("id") and not c.get("redeemed_at") and not c.get("redeem_started_at")
                      and (timestamp(c.get("expires_at")) or 0) > now), key=lambda c: timestamp(c["expires_at"]))
    items = [{"id": str(c.get("id") or ""), "label": str(c.get("title") or "Full reset")[:80], "left": 1, "total": 1,
              "expires_at": timestamp(c["expires_at"]), "reason": None} for c in credits]
    count = number(data.get("available_count"))
    return {"available": min(max(0, int(count)), len(items)) if count is not None else len(items), "items": items}


CLAUDE_GRANT_ID = re.compile(r"[a-z0-9_-]{1,40}")


def claude_grant_reason(status, grant, now):
    # Mirrors Anthropic's own checks so the dashboard never submits a claim it knows will be refused.
    starts, ends, cooldown = (timestamp(v) for v in (grant.get("starts_at"), grant.get("ends_at"), status.get("cooldown_until")))
    used = [v for v in (grant.get("percent_used") or {}).values() if isinstance(v, (int, float))]
    if not status.get("eligible"):
        return "Not available for this account"
    if grant.get("paused"):
        return "Paused by Anthropic"
    if not grant.get("usable_now"):
        return "Not usable yet"
    if grant["left"] <= 0:
        return "Used up"
    if grant.get("use_requires_limit", True) and not status.get("at_limit"):
        return "Usable once the account hits a limit"
    if grant.get("gives_back_weekly") and used and all(v == 0 for v in used):
        return "No usage to give back yet"
    if starts and starts > now:
        return "Not started yet"
    if ends and ends <= now:
        return "Expired"
    if cooldown and cooldown > now:
        return "Cooling down after the last reset"
    return None


def parse_claude_resets(status, now=None):
    if not isinstance(status, dict) or not isinstance(status.get("eligible"), bool):
        return None
    now = time.time() if now is None else now
    items = []
    for grant in status.get("grants") or []:
        left, total = (grant or {}).get("resets_left"), (grant or {}).get("resets_total")
        if (not CLAUDE_GRANT_ID.fullmatch(str(grant.get("id", ""))) or not isinstance(left, int)
                or not isinstance(total, int) or isinstance(left, bool) or not 0 <= left <= total):
            continue
        label = re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f-\x9f]", " ", str(grant.get("label") or ""))).strip()[:120]
        item = {"id": grant["id"], "label": label or "Limit reset", "left": left, "total": total,
                "expires_at": timestamp(grant.get("ends_at"))}
        item["reason"] = claude_grant_reason(status, {**grant, "left": left}, now)
        items.append(item)
    return {"available": sum(i["left"] for i in items), "items": items}


def safe_account(raw, quota=None):
    # Deliberately enumerate fields. Never relay raw credentials, id_token, paths or headers.
    now = time.time()
    cooldowns = [{k: c.get(k) for k in ["scope", "model_key", "reason", "retry_at", "http_status"]}
                 for c in raw.get("cooldowns", []) if (timestamp(c.get("retry_at")) or 0) > now]
    plan = (quota or {}).get("plan") or raw.get("id_token", {}).get("plan_type") or "Unknown"
    retry = [t for t in (timestamp(c.get("retry_at")) for c in cooldowns) if t]
    return {"id": raw["auth_index"], "provider": raw.get("provider", raw.get("type")),
            "email": raw.get("email") or raw.get("label") or "", "name": raw.get("name", ""),
            "plan": plan, "disabled": bool(raw.get("disabled")), "status": raw.get("status", "unknown"),
            "unavailable": bool(raw.get("unavailable")), "requires_sign_in": (bool(raw.get("requires_sign_in"))
                or (raw.get("refresh_error") or {}).get("code") == "invalid_grant"),
            "cooldowns": cooldowns, "success": raw.get("success", 0), "failed": raw.get("failed", 0),
            "windows": (quota or {}).get("windows", []), "quota_at": (quota or {}).get("observed_at"),
            "quota_error": (quota or {}).get("error"), "last_refresh": raw.get("last_refresh"),
            "resets": (quota or {}).get("resets"),
            "cooldown_until": max(retry) if retry else None}


def normalize_strategy(value):
    if isinstance(value, dict):
        value = value.get("strategy")
    if not isinstance(value, str):
        return ""
    raw = value.strip().lower()
    return {
        "round-robin": "round-robin",
        "roundrobin": "round-robin",
        "rr": "round-robin",
        "weighted-round-robin": "weighted-round-robin",
        "weightedroundrobin": "weighted-round-robin",
        "wrr": "weighted-round-robin",
        "fill-first": "fill-first",
        "fillfirst": "fill-first",
        "ff": "fill-first",
        "soonest-reset": "soonest-reset",
        "soonestreset": "soonest-reset",
        "sr": "soonest-reset",
    }.get(raw, raw)


def match_silo_api_key_usage(entry, api_usage):
    """Sum success+failed for one Silo registry entry from GET observability/usage/api-keys.
    Never relays cpakey or base_url."""
    if not isinstance(api_usage, dict):
        return None
    name = entry["hub_auth_name"]
    provider = entry["provider"].lower()
    base = entry["silo_cpa_base"].rstrip("/")
    key = entry["cpakey"]
    total, matched = 0, False
    # OpenAI-compatibility entries (e.g. u1) are bucketed under compat_name (hub_auth_name).
    compat_bucket = api_usage.get(name.lower())
    if isinstance(compat_bucket, dict):
        for composite, stats in compat_bucket.items():
            if not isinstance(stats, dict):
                continue
            if not isinstance(composite, str) or "|" not in composite:
                continue
            url_part, key_part = composite.rsplit("|", 1)
            if key_part == key or url_part.rstrip("/").startswith(base):
                total += int(number(stats.get("success")) or 0) + int(number(stats.get("failed")) or 0)
                matched = True
    prov_bucket = api_usage.get(provider)
    if isinstance(prov_bucket, dict):
        acct_prefix = f"{base}/acct/{name}"
        for composite, stats in prov_bucket.items():
            if not isinstance(stats, dict) or not isinstance(composite, str) or "|" not in composite:
                continue
            url_part, key_part = composite.rsplit("|", 1)
            url_clean = url_part.rstrip("/")
            if key_part != key:
                continue
            if url_clean == base or url_clean == acct_prefix or url_clean.startswith(acct_prefix + "/") or url_clean.endswith("/acct/" + name):
                total += int(number(stats.get("success")) or 0) + int(number(stats.get("failed")) or 0)
                matched = True
    return total if matched else None


def _account_window_exhausted(acct, now):
    quota_at = acct.get("quota_at")
    if acct.get("quota_error") or not quota_at or now - quota_at > 900:
        return False
    for w in acct.get("windows") or []:
        rem = number(w.get("remaining"))
        reset_at = w.get("reset_at")
        if rem is not None and rem <= 0 and (reset_at is None or reset_at > now):
            return True
    return False


def _weekly_reset_for(acct, now):
    resets = []
    for w in acct.get("windows") or []:
        if w.get("period") == 7 * 86400 and w.get("reset_at") and w["reset_at"] > now:
            resets.append(w["reset_at"])
    return min(resets) if resets else None


def pick_next_up_ids(accounts, strategy, now):
    """Return the set of account IDs that deterministic routing (fill-first or soonest-reset)
    will pick next for each provider with at least two accounts."""
    if strategy not in {"fill-first", "soonest-reset"}:
        return set()
    by_provider = {}
    for acct in accounts:
        prov = acct.get("provider")
        if prov:
            by_provider.setdefault(prov, []).append(acct)
    winners = set()
    for prov, group in by_provider.items():
        if len(group) < 2:
            continue
        eligible = [
            a for a in group
            if not a.get("disabled") and not a.get("unavailable")
            and not a.get("requires_sign_in") and not a.get("capped")
            and not _account_window_exhausted(a, now)
        ]
        if not eligible:
            continue
        def account_prio(a):
            prio = (a.get("detail") or {}).get("priority")
            return prio if isinstance(prio, int) and not isinstance(prio, bool) else 0

        max_prio = max(account_prio(a) for a in eligible)
        top = [a for a in eligible if account_prio(a) == max_prio]
        # Within the highest priority tier, Hub OAuth accounts serve the unprefixed pool first
        # (soonest-reset ranks OAuth subscriptions ahead of API-key entries).
        pool = [a for a in top if not a.get("silo")] or top

        def sort_key(a):
            prio = account_prio(a)
            ident = str(a.get("name") or a.get("id") or "")
            if strategy == "soonest-reset":
                reset_at = _weekly_reset_for(a, now)
                return (-prio, 0 if reset_at is not None else 1, reset_at if reset_at is not None else math.inf, ident)
            return (-prio, ident)

        winners.add(min(pool, key=sort_key)["id"])
    return winners
