"""Published API rates, mypriors.com subsidy priors, and per-window CU calibration lookup."""
import json
import re
import statistics
import time
import urllib.request

from quota_readers import number

MYPRIORS_URL = "https://mypriors.com/subsidies"
MYPRIORS_REFRESH_INTERVAL = 24 * 3600  # refresh cached mypriors.com subsidy priors once per day
MYPRIORS_RETRY_INTERVAL = 3600  # wait an hour before retrying after a failed fetch

# Published API list rates in USD per 1M tokens: (input, output, cache_read, cache_write).
# Kept in sync with TOK_MODEL_RATES in dashboard/assets/app-tokens.js.
MODEL_RATES = (
    # Anthropic Claude
    (re.compile(r"^claude-3-haiku\b"), (0.25, 1.25, 0.03, 0.30)),
    (re.compile(r"^claude-3-5-haiku\b"), (0.80, 4.00, 0.08, 1.00)),
    (re.compile(r"^claude-(haiku-[45]|4-5-haiku|5-5-haiku)"), (1.00, 5.00, 0.10, 1.25)),
    (re.compile(r"^claude-(3-5-sonnet|3-7-sonnet|sonnet-[45])"), (3.00, 15.00, 0.30, 3.75)),
    (re.compile(r"^claude-(3-opus|opus-4-1|opus-4-20250514|opus-4$)"), (15.00, 75.00, 1.50, 18.75)),
    (re.compile(r"^claude-(opus-4-[5-9]|opus-5|fable-5)"), (5.00, 25.00, 0.50, 6.25)),
    # OpenAI / Codex
    (re.compile(r"^gpt-5(\.\d+)?-nano"), (0.05, 0.40, 0.005, 0.0)),
    (re.compile(r"^gpt-5(\.\d+)?-mini"), (0.25, 2.00, 0.025, 0.0)),
    (re.compile(r"^gpt-5(\.\d+)?-pro"), (15.00, 120.00, 1.50, 0.0)),
    (re.compile(r"^(gpt-5\.[4-9]|gpt-6)"), (2.50, 15.00, 0.25, 0.0)),
    (re.compile(r"^gpt-5\.[23]"), (1.75, 14.00, 0.175, 0.0)),
    (re.compile(r"^(gpt-5(\.1)?\b|gpt-5-codex|gpt-5\.1-codex|codex-mini)"), (1.25, 10.00, 0.125, 0.0)),
    (re.compile(r"^gpt-oss-120b"), (0.15, 0.60, 0.075, 0.0)),
    (re.compile(r"^gpt-4\.1-nano"), (0.10, 0.40, 0.025, 0.0)),
    (re.compile(r"^gpt-4\.1-mini"), (0.40, 1.60, 0.10, 0.0)),
    (re.compile(r"^gpt-4\.1\b"), (2.00, 8.00, 0.50, 0.0)),
    (re.compile(r"^gpt-4o-mini"), (0.15, 0.60, 0.075, 0.0)),
    (re.compile(r"^gpt-4o\b"), (2.50, 10.00, 1.25, 0.0)),
    (re.compile(r"^o3-pro"), (20.00, 80.00, 2.00, 0.0)),
    (re.compile(r"^(o3-mini|o4-mini)"), (1.10, 4.40, 0.275, 0.0)),
    (re.compile(r"^o3\b"), (2.00, 8.00, 0.50, 0.0)),
    (re.compile(r"^o1-mini"), (1.10, 4.40, 0.55, 0.0)),
    (re.compile(r"^o1\b"), (15.00, 60.00, 7.50, 0.0)),
    # Google Gemini
    (re.compile(r"^gemini-.*flash-lite"), (0.10, 0.40, 0.01, 0.0)),
    (re.compile(r"^gemini-2\.5-flash"), (0.30, 2.50, 0.03, 0.0)),
    (re.compile(r"^gemini-(3(\.\d+)?-flash|flash-latest|omni-.*flash)"), (0.50, 3.00, 0.05, 0.0)),
    (re.compile(r"^gemini-2\.5-pro"), (1.25, 10.00, 0.125, 0.0)),
    (re.compile(r"^gemini-4-neon"), (3.00, 15.00, 0.30, 0.0)),
    (re.compile(r"^gemini-(3(\.\d+)?-pro|pro-latest|4-)"), (2.00, 12.00, 0.20, 0.0)),
    # xAI Grok
    (re.compile(r"^grok-3-mini"), (0.30, 0.50, 0.075, 0.0)),
    (re.compile(r"^grok-(4-fast|code-fast|4\.\d+-build-fast|composer-.*-fast)"), (0.20, 0.50, 0.05, 0.0)),
    (re.compile(r"^grok-[34]"), (3.00, 15.00, 0.75, 0.0)),
    # Moonshot Kimi
    (re.compile(r"^kimi-k[23]"), (0.60, 2.50, 0.15, 0.0)),
    # DeepSeek / GLM
    (re.compile(r"^deepseek-(v[34]|chat|reasoner)"), (0.28, 0.42, 0.028, 0.0)),
    (re.compile(r"^glm-[45]"), (0.60, 2.20, 0.11, 0.0)),
)

# Built-in fallback priors (CU = API-equivalent USD for 100% of one 1x base plan window),
# seeded from mypriors.com/subsidies. Refreshed daily via fetch_mypriors_subsidies() and
# blended smoothly toward observed hub API$/drop by Empirical Bayes calibration.
DEFAULT_API_USD_PER_1X = {
    ("claude", "5h"): 50.0,
    ("claude", "7d"): 375.0,
    ("codex", "5h"): 16.0,
    ("codex", "7d"): 69.0,
    ("antigravity", "5h"): 25.0,
    ("antigravity", "7d"): 114.0,
    ("devin", "24h"): 6.0,
    ("devin", "7d"): 29.0,
    ("xai", "7d"): 67.0,
}

# Built-in fallback relative plan weights (shared-model median ratios vs each provider's 1x base plan),
# seeded from mypriors.com/subsidies and refreshed daily by fetch_mypriors_subsidies().
DEFAULT_PLAN_WEIGHTS = {
    "claude": {"pro": 1.0, "team_premium": 4.14, "max_5x": 6.0, "ultra": 8.2},
    "codex": {"plus": 1.0, "pro_100": 10.0, "pro_200": 20.94, "pro_500": 50.0},
    "antigravity": {"pro": 1.0, "ultra_5x": 5.0, "ultra_20x": 20.0},
    "xai": {"x_plus": 0.25, "lite": 0.29, "base": 1.0, "x_super": 3.75, "plus": 4.0, "heavy": 10.0, "ultra": 12.5},
    "devin": {"pro": 1.0, "max": 4.43},
}

_MYPRIORS_SELLERS = {
    "anthropic": "claude",
    "openai": "codex",
    "google": "antigravity",
    "xai": "xai",
    "devin": "devin",
}
_MYPRIORS_BASE_TIERS = {
    "claude": "pro",
    "codex": "plus",
    "antigravity": "pro",
    "xai": "base",
    "devin": "pro",
}
_NEXT_PUSH_RE = re.compile(r'self\.__next_f\.push\(\[1,"(.*?)"\]\)', re.S)
_SELLERS_OBJ_RE = re.compile(r'\{\s*"sellers"\s*:\s*\[')


def _mypriors_plan_tier(provider, plan_name):
    """Map a mypriors.com plan display name to our canonical tier key, or None if untracked."""
    text = str(plan_name or "").strip().lower()
    if provider == "claude":
        if "ultra" in text or "20x" in text:
            return "ultra"
        if "team" in text and "premium" in text:
            return "team_premium"
        if "max" in text and "5x" in text:
            return "max_5x"
        if text == "claude pro":
            return "pro"
    elif provider == "codex":
        if "pro 500" in text or "pro500" in text:
            return "pro_500"
        if "pro 20x" in text or "pro 200" in text:
            return "pro_200"
        if "pro 10x" in text or "pro 100" in text:
            return "pro_100"
        if text == "chatgpt plus":
            return "plus"
    elif provider == "antigravity":
        if "ultra" in text and "20x" in text:
            return "ultra_20x"
        if "ultra" in text and "5x" in text:
            return "ultra_5x"
        if "google ai pro" in text:
            return "pro"
    elif provider == "xai":
        if "x ultra" in text:
            return "ultra"
        if "heavy" in text:
            return "heavy"
        if "supergrok plus" in text:
            return "plus"
        if "x super" in text:
            return "x_super"
        if "x premium" in text or text.startswith("supergrok,") or text == "supergrok":
            return "base"
        if "lite" in text:
            return "lite"
        if "x plus" in text:
            return "x_plus"
    elif provider == "devin":
        if "max" in text:
            return "max"
        if "pro" in text:
            return "pro"
    return None


def parse_mypriors_subsidies(text, fetched_at=None):
    """Extract 1x weekly CU priors and shared-model plan weight ratios from mypriors.com/subsidies."""
    raw = str(text or "")
    m = _SELLERS_OBJ_RE.search(raw)
    if not m:
        chunks = []
        for match in _NEXT_PUSH_RE.finditer(raw):
            try:
                chunks.append(json.loads('"' + match.group(1) + '"'))
            except ValueError:
                chunks.append(match.group(1))
        blob = "".join(chunks)
        m = _SELLERS_OBJ_RE.search(blob)
    else:
        blob = raw
    if not m:
        raise ValueError("mypriors.com/subsidies payload did not contain sellers data.")
    payload, _ = json.JSONDecoder().raw_decode(blob, m.start())
    sellers = payload.get("sellers")
    if not isinstance(sellers, list):
        raise ValueError("mypriors.com/subsidies sellers field is invalid.")

    priors_7d = {}
    plan_weights = {}
    for seller in sellers:
        if not isinstance(seller, dict):
            continue
        provider = _MYPRIORS_SELLERS.get(str(seller.get("id") or "").lower())
        if not provider:
            continue
        plans_by_tier = {}
        for pl in seller.get("plans") or []:
            if not isinstance(pl, dict):
                continue
            tier = _mypriors_plan_tier(provider, pl.get("plan"))
            fee = number(pl.get("feeUsd"))
            med = number(pl.get("median"))
            if not tier or not fee or fee <= 0 or not med or med <= 0:
                continue
            models = {}
            for m in pl.get("models") or []:
                if not isinstance(m, dict):
                    continue
                mid = str(m.get("id") or "").strip().lower()
                mult = number(m.get("multiple"))
                if mid and mult and mult > 0:
                    models[mid] = fee * mult
            # Keep the first matching plan (current non-legacy plans precede legacy entries on mypriors).
            plans_by_tier.setdefault(tier, {"monthly": fee * med, "models": models})

        base_tier = _MYPRIORS_BASE_TIERS[provider]
        base = plans_by_tier.get(base_tier)
        if not base or base["monthly"] <= 0:
            continue
        weekly = round(base["monthly"] / (30.4375 / 7.0), 2)
        if 1.0 <= weekly <= 10000.0:
            priors_7d[provider] = weekly
        weights = {}
        base_models = base["models"]
        for tier, info in plans_by_tier.items():
            if tier == base_tier:
                weights[tier] = 1.0
                continue
            shared = [info["models"][mid] / base_models[mid]
                      for mid in info["models"] if mid in base_models and base_models[mid] > 0]
            ratio = statistics.median(shared) if shared else (info["monthly"] / base["monthly"])
            ratio = round(float(ratio), 2)
            if 0.05 <= ratio <= 500.0:
                weights[tier] = ratio
        if weights:
            plan_weights[provider] = weights

    if not priors_7d and not plan_weights:
        raise ValueError("mypriors.com/subsidies contained no recognized provider plans.")
    return {
        "fetched_at": float(fetched_at if fetched_at is not None else time.time()),
        "source": "mypriors.com/subsidies",
        "priors_7d": priors_7d,
        "plan_weights": plan_weights,
    }


def fetch_mypriors_subsidies(timeout=15):
    req = urllib.request.Request(MYPRIORS_URL, headers={"User-Agent": "silo-dashboard/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        html = resp.read().decode("utf-8", "replace")
    return parse_mypriors_subsidies(html)


_MODEL_PREFIX_RE = re.compile(r"^(anthropic|openai|google|xai|moonshot|devin|vertex|gemini|antigravity|claude|codex)/")
_SCOPED_CALIBRATION_RE = re.compile(r"^(weekly_scoped:|seven_day_|iguana_necktie$|product:|code_review_rate_limit:)")


def model_api_rate(model):
    if not model:
        return None
    name = _MODEL_PREFIX_RE.sub("", str(model).strip().lower())
    name = re.sub(r"^models/", "", name)
    if not name:
        return None
    for rx, rate in MODEL_RATES:
        if rx.search(name):
            return rate
    return None


def bucket_api_cost(provider, model, inp, outp, cache_read, cache_write):
    rate = model_api_rate(model)
    if not rate:
        return None
    # OpenAI and Gemini include cache reads in input_tokens; Claude reports them separately.
    uncached_in = inp if provider == "claude" else max(0, inp - cache_read)
    return (uncached_in * rate[0] + outp * rate[1] + cache_read * rate[2] + (cache_write or 0) * rate[3]) / 1e6


def uncached_api_cost(model, uncached_in, outp, cache_read, cache_write=0):
    """Estimated API cost in USD from already-separated uncached input tokens."""
    rate = model_api_rate(model)
    if not rate:
        return None
    return (
        max(0, uncached_in) * rate[0]
        + max(0, outp) * rate[1]
        + max(0, cache_read) * rate[2]
        + max(0, cache_write or 0) * rate[3]
    ) / 1e6


def window_period_key(period):
    p = number(period)
    if not p or p <= 0:
        return "other"
    if abs(p - 5 * 3600) <= 600:
        return "5h"
    if abs(p - 86400) <= 3600:
        return "24h"
    if abs(p - 7 * 86400) <= 7200:
        return "7d"
    if abs(p - 30 * 86400) <= 3 * 86400:
        return "30d"
    return "7d" if p > 2 * 86400 else "5h"


def antigravity_model_group(model):
    name = _MODEL_PREFIX_RE.sub("", str(model or "").strip().lower())
    name = re.sub(r"^models/", "", name)
    return "gemini" if name.startswith("gemini") else "3p"


def antigravity_window_group(metric, group=None):
    text = f"{group or ''} {metric or ''}".lower()
    return "gemini" if "gemini" in text else "3p"


def default_api_usd_prior(provider, period_key, priors_data=None):
    p = str(provider or "").lower()
    live_7d = number((priors_data or {}).get("priors_7d", {}).get(p))
    if live_7d and live_7d > 0:
        if period_key == "7d":
            return round(live_7d, 2)
        if period_key == "30d":
            return round(live_7d * (30.4375 / 7.0), 2)
        builtin_7d = DEFAULT_API_USD_PER_1X.get((p, "7d"))
        builtin_pk = DEFAULT_API_USD_PER_1X.get((p, period_key))
        if builtin_7d and builtin_pk:
            return round(live_7d * (builtin_pk / builtin_7d), 2)
        if period_key == "24h":
            return round(live_7d / 5.0, 2)
        if period_key == "5h":
            return round(live_7d / 5.0, 2)
    if (p, period_key) in DEFAULT_API_USD_PER_1X:
        return DEFAULT_API_USD_PER_1X[(p, period_key)]
    if period_key == "30d" and (p, "7d") in DEFAULT_API_USD_PER_1X:
        return round(DEFAULT_API_USD_PER_1X[(p, "7d")] * (30.4375 / 7.0), 2)
    if period_key == "24h" and (p, "7d") in DEFAULT_API_USD_PER_1X:
        return round(DEFAULT_API_USD_PER_1X[(p, "7d")] / 5.0, 2)
    return DEFAULT_API_USD_PER_1X.get((p, "7d")) or DEFAULT_API_USD_PER_1X.get((p, "5h")) or 25.0


def calibration_lookup(cal_map, provider, period_key, group=None, priors_data=None):
    p = str(provider or "").lower()
    if p == "antigravity" and group:
        entry = cal_map.get((p, period_key, group))
        if entry and entry.get("obs_1x_drop", 0) > 0:
            return entry
    entry = cal_map.get((p, period_key))
    if entry:
        return entry
    prior = default_api_usd_prior(p, period_key, priors_data=priors_data)
    has_live = bool(number((priors_data or {}).get("priors_7d", {}).get(p)))
    return {"usd_per_1x": prior, "prior_usd": prior, "obs_usd": None,
            "obs_1x_drop": 0.0, "obs_cost": 0.0, "obs_hours": 0, "source": "estimate",
            "prior_source": "mypriors" if has_live else "builtin"}
