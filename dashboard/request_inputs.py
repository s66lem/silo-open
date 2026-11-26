"""Validation of browser input (subscriptions, client keys, nicknames, plans, weights). Anything
refused raises InputError, whose message is shown as is."""
from datetime import date
import re

from api_pricing import DEFAULT_PLAN_WEIGHTS
from quota_readers import number

CLIENT_KEY_SECRET = re.compile(r"cpk_[A-Za-z0-9_-]{8,200}")
CLIENT_KEY_PROVIDER = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}")
CLIENT_KEY_FIELDS = ["id", "name", "hint", "enabled", "providers", "accounts", "models", "weekly_token_limit",
                     "weekly_tokens", "created_at", "updated_at"]

MAX_TOKEN_LIMIT = 10**15


class InputError(ValueError):
    """A request the dashboard refuses before calling the proxy. The message is shown as is."""


def subscription_key(raw):
    claims = raw.get("id_token") or {}
    if raw.get("provider", raw.get("type")) == "codex" and isinstance(claims, dict) and claims.get("chatgpt_account_id"):
        return "codex-account:" + str(claims["chatgpt_account_id"]) + ":" + str(raw.get("email") or "").casefold()
    return raw.get("name")


def subscription_terms(body, shared):
    kind = body.get("kind")
    if kind == "clear":
        return None
    if kind not in (("estimate",) if shared else ("free", "paid", "trial", "trial-renews")):
        raise InputError("Choose a billing status for this account.")
    if kind == "free":
        return {"kind": kind}
    terms = {"kind": kind}
    if kind != "trial":
        cents, cycle = body.get("cents"), body.get("cycle")
        if type(cents) is not int or not 0 <= cents <= 999999999 or cycle not in ("monthly", "yearly"):
            raise InputError("Enter a valid USD amount and billing interval.")
        terms.update(cents=cents, cycle=cycle)
    if not shared:
        try:
            when = date.fromisoformat(body["date"])
            if when.isoformat() != body["date"] or when.year < 1900:
                raise ValueError
        except (ValueError, TypeError, KeyError):
            raise InputError("Enter a valid renewal or trial end date.") from None
        terms["date"] = when.isoformat()
    return terms


def text_value(value, limit, what):
    if not isinstance(value, str):
        raise InputError(f"{what} must be text.")
    value = value.strip()
    if not value or len(value) > limit or re.search(r"[\x00-\x1f\x7f]", value):
        raise InputError(f"{what} is empty, too long, or has control characters.")
    return value


def text_list(value, limit, what, pattern=None, lower=False):
    if not isinstance(value, list) or len(value) > 200:
        raise InputError(f"{what} must be a list.")
    out = []
    for item in value:
        item = text_value(item, limit, what)
        item = item.lower() if lower else item
        if pattern and not pattern.fullmatch(item):
            raise InputError(f"{what} has an unexpected value.")
        if item not in out:
            out.append(item)
    return out


def client_key_input(body, create=False):
    """Checks the editable fields of a client key; only fields present are sent to the proxy."""
    out = {}
    if create or "name" in body:
        out["name"] = text_value(body.get("name"), 80, "Name")
    if "enabled" in body:
        if not isinstance(body["enabled"], bool):
            raise InputError("Enabled must be true or false.")
        out["enabled"] = body["enabled"]
    if "providers" in body:
        out["providers"] = text_list(body["providers"], 64, "Providers", CLIENT_KEY_PROVIDER, lower=True)
    if "accounts" in body:
        out["accounts"] = text_list(body["accounts"], 256, "Accounts")
    if "models" in body:
        # Patterns: * matches any run of characters, ? one character; no spaces.
        out["models"] = text_list(body["models"], 128, "Model patterns", re.compile(r"\S+"), lower=True)
    if "weekly_token_limit" in body:
        limit = body["weekly_token_limit"]
        if isinstance(limit, bool) or not isinstance(limit, int) or not 0 <= limit <= MAX_TOKEN_LIMIT:
            raise InputError("The weekly token limit must be a whole number, 0 for no limit.")
        out["weekly_token_limit"] = limit
    if not create and not out:
        raise InputError("Nothing to change.")
    return out


def safe_client_key(raw):
    # Enumerate fields: a secret or hash never reaches the page outside create and rotate.
    key = {k: raw.get(k) for k in CLIENT_KEY_FIELDS}
    for k in ["providers", "accounts", "models"]:
        key[k] = [str(v) for v in key[k] or []]
    key["hint"] = str(key["hint"] or "")[-4:]
    key["enabled"] = bool(key["enabled"])
    key["weekly_token_limit"] = int(number(key["weekly_token_limit"]) or 0)
    key["weekly_tokens"] = int(number(key["weekly_tokens"]) or 0)
    return key


def client_key_secret(result):
    secret = str(result.get("secret") or "")
    if not CLIENT_KEY_SECRET.fullmatch(secret):
        raise ValueError("The proxy returned an unexpected key.")
    return secret


NICKNAME_LIMIT = 40


PROVIDER_NAME = re.compile(r"[a-z0-9][a-z0-9-]{0,31}")


def clean_provider_order(value):
    """The owner's provider order: a list of provider ids, deduplicated. Unknown or new
    providers are not rejected; the page appends any provider missing from the list."""
    if not isinstance(value, list) or len(value) > 30 or not all(isinstance(p, str) and PROVIDER_NAME.fullmatch(p) for p in value):
        raise InputError("The provider order must be a list of provider names.")
    return list(dict.fromkeys(value))


def clean_nickname(value):
    """A nickname is trimmed text up to 40 characters; empty means clear it."""
    if value is None:
        return ""
    if not isinstance(value, str):
        raise InputError("The nickname must be text.")
    value = value.strip()
    if len(value) > NICKNAME_LIMIT or re.search(r"[\x00-\x1f\x7f]", value):
        raise InputError(f"Use up to {NICKNAME_LIMIT} characters, without control characters.")
    return value


def default_plan_weight(provider, plan=None, profile=None, plan_weights=None):
    """Default relative capacity multiplier (1x = standard individual paid plan for that provider).

    Tier multipliers use empirical shared-model ratios from mypriors.com/subsidies when available
    (via plan_weights) and fall back to DEFAULT_PLAN_WEIGHTS."""
    p = str(provider or "").lower()
    text = str(plan or "").strip().lower()
    tier = str((profile or {}).get("rate_limit_tier") or "").strip().lower()
    seat = str((profile or {}).get("seat") or "").strip().lower()

    def pw(key, fallback):
        live = number((plan_weights or {}).get(p, {}).get(key))
        if live and live > 0:
            return live
        return DEFAULT_PLAN_WEIGHTS.get(p, {}).get(key, fallback)

    if p == "claude":
        for src in (tier, text):
            if "ultra" in src or re.search(r"\b20x\b", src) or "max_20x" in src:
                return pw("ultra", 8.2)
            if re.search(r"\b5x\b", src) or "max_5x" in src:
                return pw("max_5x", 6.0)
            m = re.search(r"(\d+(?:\.\d+)?)x\b", src)
            if m:
                return float(m.group(1))
        if "standard" in text or "standard" in seat:
            return 1.25
        if "premium" in text or "premium" in seat or "tier_1" in seat or "claude teams" in text:
            return pw("team_premium", 4.14)
        if "max" in text:
            return pw("max_5x", 6.0)
        if "team" in text or "enterprise" in text:
            return 1.25
        if "free" in text:
            return 0.25
        return 1.0
    if p == "codex":
        if text in {"pro 500", "pro500"}:
            return pw("pro_500", 50.0)
        if text in {"pro", "pro 200", "pro200", "pro 20x"}:
            return pw("pro_200", 20.94)
        if text in {"prolite", "pro 100", "pro100", "pro 10x"}:
            return pw("pro_100", 10.0)
        if "premium" in text:
            return 5.0
        if text == "team":
            return 2.0
        if text == "go":
            return 0.5
        if text == "free":
            return 0.25
        return 1.0
    if p == "antigravity":
        if "ultra" in text:
            if "20x" in text or "200" in text:
                return pw("ultra_20x", 20.0)
            return pw("ultra_5x", 5.0)
        return 1.0
    if p == "xai":
        if "ultra" in text:
            return pw("ultra", 12.5)
        if "heavy" in text:
            return pw("heavy", 10.0)
        if "super" in text and "grok" not in text:
            return pw("x_super", 3.75)
        if "plus" in text and "grok" not in text:
            return pw("x_plus", 0.25)
        if "plus" in text or "premium+" in text:
            return pw("plus", 4.0)
        if "lite" in text or "basic" in text:
            return pw("lite", 0.29)
        if "free" in text:
            return 0.25
        return 1.0
    if p == "devin":
        if "max" in text:
            return pw("max", 4.43)
        if "free" in text:
            return 0.25
        return 1.0
    return 1.0


PLAN_LIMIT = 48


def clean_plan(value):
    """Owner plan override: trimmed text up to 48 characters, or None/empty to reset to Auto."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise InputError("The plan must be text.")
    value = value.strip()
    if not value:
        return None
    if len(value) > PLAN_LIMIT or re.search(r"[\x00-\x1f\x7f]", value):
        raise InputError(f"Use up to {PLAN_LIMIT} characters, without control characters.")
    return value


def clean_weight(value):
    """Owner capacity weight override: a positive number 0.05-1000, or None/empty to reset to Auto."""
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise InputError("The capacity weight must be a number between 0.05 and 1000.")
    parsed = number(value)
    if parsed is None or not 0.05 <= parsed <= 1000:
        raise InputError("The capacity weight must be a number between 0.05 and 1000.")
    return round(parsed, 3)
