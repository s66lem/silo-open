"""The dashboard's own sqlite store (quota samples, imported history, settings, token usage) and
the pooled history series built from it."""
import array
import bisect
from contextlib import contextmanager
import json
import re
import sqlite3
import threading
import time

from quota_readers import codex_window_key, codex_window_label
from request_inputs import subscription_key
from api_pricing import (DEFAULT_API_USD_PER_1X, _SCOPED_CALIBRATION_RE, antigravity_model_group,
                         antigravity_window_group, bucket_api_cost, default_api_usd_prior, window_period_key)

CALIBRATION_PRIOR_PCT = 25.0  # Empirical Bayes prior strength (25% of one 1x window)

HISTORY_POINTS = 720  # most points per series sent to the browser
HISTORY_RETENTION = 30 * 86400  # live samples older than this are pruned
PRUNE_INTERVAL = 3600  # prune at most hourly instead of on every save

CLIENT_KEY_USAGE_FIELDS = ["requests", "failed", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "tokens"]
LIVE_BUCKET_FIELDS = ["key_id", "hour", "provider", "account", "model", *CLIENT_KEY_USAGE_FIELDS]


def history_gap(bucket):
    """Longest pause between two samples still drawn and integrated as one line: about 2.5 history
    buckets (longer ranges arrive downsampled), never under 15 minutes. The browser reads it from
    the snapshot's history_gap so both sides agree."""
    return max(900, 2.5 * bucket)


def history_series(rows):
    """Group flat history rows (sorted by ts) into one column set per account and metric, which is
    far smaller on the wire than one object per sample and is what the browser indexes anyway.
    Returns (series, legacy), where legacy rebuilds the flat rows exactly (history_rows): each
    series' provider and period columns, which only the flat format sends ([value] when constant),
    and the series index of every row in the original order."""
    out, extra, order = {}, {}, array.array("I")
    for r in rows:
        key = (r["account"], r["metric"])
        series = out.get(key)
        if series is None:
            series = out[key] = {"account": r["account"], "metric": r["metric"], "ts": [], "remaining": [], "reset_at": []}
            extra[key] = (len(extra), [], [])
        series["ts"].append(r["ts"])
        series["remaining"].append(r["remaining"])
        series["reset_at"].append(r["reset_at"])
        index, providers, periods = extra[key]
        providers.append(r["provider"])
        periods.append(r["period"])
        order.append(index)
    # Nearly always one provider and period per series; keep only that, not a column of repeats.
    columns = [tuple([c[0]] if c.count(c[0]) == len(c) else c for c in (providers, periods))
               for _, providers, periods in extra.values()]
    return list(out.values()), {"columns": columns, "order": order}


def history_rows(series, legacy):
    """The flat rows history_series was given, in their original order."""
    cursor = [0] * len(series)
    rows = []
    for index in legacy["order"]:
        s, (providers, periods), i = series[index], legacy["columns"][index], cursor[index]
        cursor[index] = i + 1
        rows.append({"ts": s["ts"][i], "account": s["account"], "provider": providers[i if len(providers) > 1 else 0],
                     "metric": s["metric"], "remaining": s["remaining"][i], "reset_at": s["reset_at"][i],
                     "period": periods[i if len(periods) > 1 else 0]})
    return rows


def pool_series(rows, ids, metric, gap, weights=None, usd_per_1x=None, retired=(), backfill=False, silo_ids=(),
                carry_forward=False, fallback_latest=None):
    """Pooled remaining % for the accounts in ids over recorded samples of one metric.

    Each account keeps its latest value until its next sample, so accounts read at
    different times still add up. A value older than gap seconds counts as missing: no
    total is emitted then (never a fake dip), and the next point carries gap=True so the
    chart breaks the line instead of joining across it. An account that first starts
    reporting later (e.g. a newly added Cyclone laptop account) joins from its first
    sample with a segment break instead of erasing earlier history.

    When weights ({account_id: weight}) is given, each point also carries normalized
    `units` (sum of weight_i * remaining_i / 100) and active `weight` (sum of weight_i)
    so the UI can switch between weighted %, x units, and raw % without re-fetching.
    When usd_per_1x is also given, each point carries `usd` (API-equivalent USD remaining).
    When silo_ids is given, each point also carries the Idlenet seat share (`silo_value`,
    and `silo_units`/`silo_usd` when weights/usd_per_1x are provided).

    Accounts in retired (disabled now) count only while their reading is fresh: a stretch
    without readings drops them from the pool, with segment breaks, instead of blanking the
    pooled line.

    With carry_forward, an already-joined account (or one seeded from fallback_latest when
    its last good reading predates the window) carries its last known value forward when
    its polls stop (e.g. Sign-in needed, offline capped seat, or Quota unavailable) so live
    accounts continue plotting smoothly up to now; only a recording outage across the whole
    pool or a membership change emits gap=True.

    With backfill, an account that starts reporting later counts at its first reading from the
    start instead of joining with a step, and a late reading carries forward instead of breaking
    the line (the All accounts stack, so bands don't jump); only a stretch with no readings at
    all from these accounts breaks it."""
    ids = set(ids)
    retired = set(retired) & ids
    silo_ids = set(silo_ids) & ids
    rows = sorted((r for r in rows if r["account"] in ids and r["metric"] == metric), key=lambda r: r["ts"])
    first_ts, first_row = {}, {}
    for r in rows:
        first_ts.setdefault(r["account"], r["ts"])
        first_row.setdefault(r["account"], r)
    if backfill:
        return backfilled_series(rows, sorted(first_ts), first_row, gap, weights, usd_per_1x, silo_ids=silo_ids,
                                 fallback_latest=fallback_latest, ids=ids)
    if carry_forward:
        if not first_ts:
            return []
        min_ts = min(first_ts.values())
        latest, active = {}, []
        if fallback_latest:
            for a in sorted(ids - set(first_ts)):
                if a not in fallback_latest:
                    continue
                raw = fallback_latest[a]
                rem, obs = raw if isinstance(raw, tuple) else (raw, None)
                if obs is None or obs <= min_ts:
                    latest[a] = {"remaining": rem, "ts": float("-inf")}
                    active.append(a)
        joiners = sorted(first_ts, key=first_ts.get)
        joined, out, last_ts, prev_members = 0, [], None, None
        for i, r in enumerate(rows):
            latest[r["account"]] = r
            if i + 1 < len(rows) and rows[i + 1]["ts"] == r["ts"]:
                continue
            cutoff = max(r["ts"], min_ts + gap)
            while joined < len(joiners) and first_ts[joiners[joined]] <= cutoff:
                bisect.insort(active, joiners[joined])
                joined += 1
            members = tuple(active)
            if active and all(a in latest for a in active):
                point = {"ts": r["ts"], "value": sum(latest[a]["remaining"] for a in active)}
                if silo_ids:
                    silo_live = [a for a in active if a in silo_ids]
                    point["silo_value"] = sum(latest[a]["remaining"] for a in silo_live)
                if weights is not None:
                    units = sum(weights.get(a, 1.0) * latest[a]["remaining"] / 100.0 for a in active)
                    point["units"] = round(units, 4)
                    point["weight"] = round(sum(weights.get(a, 1.0) for a in active), 4)
                    if usd_per_1x is not None:
                        point["usd"] = round(units * usd_per_1x, 2)
                        point["usd_cap"] = round(point["weight"] * usd_per_1x, 2)
                    if silo_ids:
                        silo_units = sum(weights.get(a, 1.0) * latest[a]["remaining"] / 100.0 for a in silo_live)
                        point["silo_units"] = round(silo_units, 4)
                        if usd_per_1x is not None:
                            point["silo_usd"] = round(silo_units * usd_per_1x, 2)
                if (last_ts is not None and r["ts"] - last_ts > gap) or (prev_members is not None and members != prev_members):
                    point["gap"] = True
                out.append(point)
                last_ts = r["ts"]
                prev_members = members
        return out
    ids -= retired - set(first_ts)  # a retired account with no samples in range is simply not a member
    if len(first_ts) != len(ids) or not ids:
        return []
    min_ts = min(first_ts.values())
    # cutoff never decreases, so accounts only ever join the active set: add them in first-sample order.
    joiners = sorted(first_ts, key=first_ts.get)
    active, joined = [], 0
    latest, out, broken, prev_members = {}, [], False, None
    for i, r in enumerate(rows):
        latest[r["account"]] = r
        if i + 1 < len(rows) and rows[i + 1]["ts"] == r["ts"]:
            continue
        cutoff = max(r["ts"], min_ts + gap)
        while joined < len(joiners) and first_ts[joiners[joined]] <= cutoff:
            bisect.insort(active, joiners[joined])  # sorted, so sums add up in the same order as before
            joined += 1
        live = active
        if retired:  # a retired account only counts while its reading is fresh
            live = [a for a in active if a not in retired or (a in latest and r["ts"] - latest[a]["ts"] <= gap)]
        members = tuple(live)
        if live and all(a in latest and r["ts"] - latest[a]["ts"] <= gap for a in live):
            point = {"ts": r["ts"], "value": sum(latest[a]["remaining"] for a in live)}
            if silo_ids:
                silo_live = [a for a in live if a in silo_ids]
                point["silo_value"] = sum(latest[a]["remaining"] for a in silo_live)
            if weights is not None:
                units = sum(weights.get(a, 1.0) * latest[a]["remaining"] / 100.0 for a in live)
                point["units"] = round(units, 4)
                point["weight"] = round(sum(weights.get(a, 1.0) for a in live), 4)
                if usd_per_1x is not None:
                    point["usd"] = round(units * usd_per_1x, 2)
                    point["usd_cap"] = round(point["weight"] * usd_per_1x, 2)
                if silo_ids:
                    silo_units = sum(weights.get(a, 1.0) * latest[a]["remaining"] / 100.0 for a in silo_live)
                    point["silo_units"] = round(silo_units, 4)
                    if usd_per_1x is not None:
                        point["silo_usd"] = round(silo_units * usd_per_1x, 2)
            if broken or (prev_members is not None and members != prev_members):
                point["gap"] = True
            out.append(point)
            broken = False
            prev_members = members
        elif out:
            broken = True
    return out


def backfilled_series(rows, accounts, first_row, gap, weights=None, usd_per_1x=None, silo_ids=(),
                      fallback_latest=None, ids=None):
    """pool_series with backfill: every account counts at all times, at its first reading before it
    starts reporting and at its latest one after."""
    if not accounts:
        return []
    latest = dict(first_row)
    accounts = list(accounts)
    if fallback_latest:
        min_ts = min(r["ts"] for r in rows)
        extra_ids = set(ids) if ids is not None else set(fallback_latest)
        for a in sorted(extra_ids - set(first_row)):
            if a not in fallback_latest:
                continue
            raw = fallback_latest[a]
            rem, obs = raw if isinstance(raw, tuple) else (raw, None)
            if obs is None or obs <= min_ts:
                latest[a] = {"remaining": rem}
                bisect.insort(accounts, a)
    silo_accounts = [a for a in accounts if a in silo_ids]
    out, last_ts = [], None
    for i, r in enumerate(rows):
        latest[r["account"]] = r
        if i + 1 < len(rows) and rows[i + 1]["ts"] == r["ts"]:
            continue
        point = {"ts": r["ts"], "value": sum(latest[a]["remaining"] for a in accounts)}
        if silo_accounts:
            point["silo_value"] = sum(latest[a]["remaining"] for a in silo_accounts)
        if weights is not None:
            units = sum(weights.get(a, 1.0) * latest[a]["remaining"] / 100.0 for a in accounts)
            point["units"] = round(units, 4)
            point["weight"] = round(sum(weights.get(a, 1.0) for a in accounts), 4)
            if usd_per_1x is not None:
                point["usd"] = round(units * usd_per_1x, 2)
                point["usd_cap"] = round(point["weight"] * usd_per_1x, 2)
            if silo_accounts:
                silo_units = sum(weights.get(a, 1.0) * latest[a]["remaining"] / 100.0 for a in silo_accounts)
                point["silo_units"] = round(silo_units, 4)
                if usd_per_1x is not None:
                    point["silo_usd"] = round(silo_units * usd_per_1x, 2)
        if last_ts is not None and r["ts"] - last_ts > gap:
            point["gap"] = True
        out.append(point)
        last_ts = r["ts"]
    return out


def pool_stack(series_by_provider, gap, retired=(), backfill=False):
    """Stack per-provider pooled series: one band per provider, total height = their sum.

    Same staleness rule as pool_series: each provider keeps its last point until its next
    one, a value older than gap seconds counts as missing and no stacked point is emitted
    then (the next one carries gap=True). A provider that first appears later (more than
    gap seconds after the earliest series) joins from its first sample instead of erasing
    earlier history, starting a new segment when the active provider set changes. A provider
    in retired (every account disabled) counts only while its last point is fresh.

    With backfill, providers with any points all count at all times (at their first point
    before it, carried forward after), so bands never appear or vanish; providers with none
    are left out. Only a stretch with no points at all breaks the line."""
    if backfill:
        return backfilled_stack({n: pts for n, pts in series_by_provider.items() if pts}, gap)
    retired = {n for n in retired if n in series_by_provider}
    series_by_provider = {n: pts for n, pts in series_by_provider.items() if pts or n not in retired}
    names = sorted(n for n, pts in series_by_provider.items() if pts)
    if len(names) != len(series_by_provider) or not names:
        return []
    first_ts = {n: min(p["ts"] for p in series_by_provider[n]) for n in names}
    min_ts = min(first_ts.values())
    min_providers = min(2, len(names) - len(retired) or 1)
    has_weights = all("units" in p and "weight" in p for n in names for p in series_by_provider[n])
    has_usd = has_weights and all("usd" in p for n in names for p in series_by_provider[n])
    has_usd_cap = has_usd and all("usd_cap" in p for n in names for p in series_by_provider[n])
    has_silo = any("silo_value" in p for n in names for p in series_by_provider[n])
    events = sorted((p["ts"], n, k) for n in names for k, p in enumerate(series_by_provider[n]))
    latest, out, broken, prev_active = {}, [], False, None
    for i, (ts, name, k) in enumerate(events):
        latest[name] = series_by_provider[name][k]
        if i + 1 < len(events) and events[i + 1][0] == ts:
            continue
        cutoff = max(ts, min_ts + gap)
        active = tuple(n for n in names if first_ts[n] <= cutoff
                       and (n not in retired or (n in latest and ts - latest[n]["ts"] <= gap)))
        if len(active) < min_providers:
            continue
        if all(n in latest and ts - latest[n]["ts"] <= gap for n in active):
            point = {"ts": ts, "value": sum(latest[n]["value"] for n in active),
                     "parts": {n: latest[n]["value"] for n in active}}
            if has_silo:
                point["silo_parts"] = {n: latest[n]["silo_value"] for n in active if "silo_value" in latest[n]}
            if has_weights:
                parts_units = {n: round(latest[n]["units"], 4) for n in active}
                parts_pct = {n: round((latest[n]["units"] / latest[n]["weight"] * 100.0) if latest[n]["weight"] > 0 else 0.0, 3) for n in active}
                point["units"] = round(sum(parts_units.values()), 4)
                point["parts_units"] = parts_units
                point["parts_pct"] = parts_pct
                point["weighted"] = round(sum(parts_pct.values()) / len(active), 3)
                if has_silo:
                    point["silo_parts_units"] = {n: round(latest[n]["silo_units"], 4) for n in active if "silo_units" in latest[n]}
                    point["silo_parts_pct"] = {
                        n: round((latest[n]["silo_units"] / latest[n]["weight"] * 100.0) if latest[n]["weight"] > 0 else 0.0, 3)
                        for n in active if "silo_units" in latest[n]
                    }
            if has_usd:
                parts_usd = {n: round(latest[n]["usd"], 2) for n in active}
                point["usd"] = round(sum(parts_usd.values()), 2)
                point["parts_usd"] = parts_usd
                if has_usd_cap:
                    point["usd_cap"] = round(sum(latest[n]["usd_cap"] for n in active), 2)
                if has_silo:
                    point["silo_parts_usd"] = {n: round(latest[n]["silo_usd"], 2) for n in active if "silo_usd" in latest[n]}
            if broken or (prev_active is not None and active != prev_active):
                point["gap"] = True
            out.append(point)
            broken = False
            prev_active = active
        elif out:
            broken = True
    return out


def backfilled_stack(series_by_provider, gap):
    """pool_stack with backfill: every provider counts at every point. The stack starts once a
    second provider reports, so one provider's longer history isn't padded with invented bands."""
    names = sorted(series_by_provider)
    if not names:
        return []
    has_weights = all("units" in p and "weight" in p for n in names for p in series_by_provider[n])
    has_usd = has_weights and all("usd" in p for n in names for p in series_by_provider[n])
    has_usd_cap = has_usd and all("usd_cap" in p for n in names for p in series_by_provider[n])
    has_silo = any("silo_value" in p for n in names for p in series_by_provider[n])
    start = sorted(series_by_provider[n][0]["ts"] for n in names)[min(1, len(names) - 1)]
    latest = {n: series_by_provider[n][0] for n in names}
    events = sorted((p["ts"], n, k) for n in names for k, p in enumerate(series_by_provider[n]))
    out, last_ts = [], None
    for i, (ts, name, k) in enumerate(events):
        latest[name] = series_by_provider[name][k]
        if (i + 1 < len(events) and events[i + 1][0] == ts) or ts < start:
            continue
        point = {"ts": ts, "value": sum(latest[n]["value"] for n in names),
                 "parts": {n: latest[n]["value"] for n in names}}
        if has_silo:
            point["silo_parts"] = {n: latest[n]["silo_value"] for n in names if "silo_value" in latest[n]}
        if has_weights:
            parts_units = {n: round(latest[n]["units"], 4) for n in names}
            parts_pct = {n: round((latest[n]["units"] / latest[n]["weight"] * 100.0) if latest[n]["weight"] > 0 else 0.0, 3)
                         for n in names}
            point["units"] = round(sum(parts_units.values()), 4)
            point["parts_units"] = parts_units
            point["parts_pct"] = parts_pct
            point["weighted"] = round(sum(parts_pct.values()) / len(names), 3)
            if has_silo:
                point["silo_parts_units"] = {n: round(latest[n]["silo_units"], 4) for n in names if "silo_units" in latest[n]}
                point["silo_parts_pct"] = {
                    n: round((latest[n]["silo_units"] / latest[n]["weight"] * 100.0) if latest[n]["weight"] > 0 else 0.0, 3)
                    for n in names if "silo_units" in latest[n]
                }
        if has_usd:
            parts_usd = {n: round(latest[n]["usd"], 2) for n in names}
            point["usd"] = round(sum(parts_usd.values()), 2)
            point["parts_usd"] = parts_usd
            if has_usd_cap:
                point["usd_cap"] = round(sum(latest[n]["usd_cap"] for n in names), 2)
            if has_silo:
                point["silo_parts_usd"] = {n: round(latest[n]["silo_usd"], 2) for n in names if "silo_usd" in latest[n]}
        if last_ts is not None and ts - last_ts > gap:
            point["gap"] = True
        out.append(point)
        last_ts = ts
    return out


def downsample_series(points, bucket):
    """Coalesce pooled points to at most one per time bucket (keeping each bucket's latest
    state) while preserving segment breaks (`gap: True`). Multiple accounts and providers
    report at staggered timestamps inside each history bucket; without bucketing, pooled
    series multiply HISTORY_POINTS by the account count."""
    if not points or not bucket or bucket <= 0:
        return points
    out = []
    cur_bucket = None
    for p in points:
        b = int(p["ts"] // bucket)
        if p.get("gap"):
            out.append(p)
            cur_bucket = b
        elif out and b == cur_bucket:
            if out[-1].get("gap"):
                p = {**p, "gap": True}
            out[-1] = p
        else:
            out.append(p)
            cur_bucket = b
    return out


class Store:
    def __init__(self, path):
        self.path = path
        self.version = 0  # bumped on every sample write, so readers can cache what they derive from history
        self.version_lock = threading.Lock()
        self.pruned_at = 0.0
        with self.connect() as db:
            # WAL lets the collector write while page requests read; it persists in the database file.
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("CREATE TABLE IF NOT EXISTS samples (ts REAL, account TEXT, provider TEXT, metric TEXT, remaining REAL, reset_at REAL, period REAL, PRIMARY KEY(ts,account,metric))")
            db.execute("CREATE INDEX IF NOT EXISTS samples_time ON samples(ts)")
            db.execute("CREATE TABLE IF NOT EXISTS latest (account TEXT PRIMARY KEY, data TEXT)")
            # Only a hash of each session token is stored, with the management key it was issued for.
            db.execute("CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires REAL, key_hash TEXT)")
            # Owner-chosen display names, keyed by credential file name (stable across restarts).
            # History imported from before Silo (import_history.py): kept apart so live samples are
            # never overwritten and the import can be removed; the readers below union both.
            db.execute("CREATE TABLE IF NOT EXISTS samples_imported (ts REAL, account TEXT, provider TEXT, metric TEXT, remaining REAL, reset_at REAL, period REAL, PRIMARY KEY(ts,account,metric))")
            db.execute("CREATE TABLE IF NOT EXISTS tokens_imported (hour REAL, provider TEXT, account TEXT, model TEXT, requests INTEGER, failed INTEGER, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, PRIMARY KEY(hour,provider,account,model))")
            db.execute("CREATE TABLE IF NOT EXISTS tokens_live (key_id TEXT, hour REAL, provider TEXT, account TEXT, model TEXT, requests INTEGER, failed INTEGER, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, tokens INTEGER, PRIMARY KEY(key_id,hour,provider,account,model))")
            db.execute("CREATE TABLE IF NOT EXISTS account_aliases (auth_id TEXT PRIMARY KEY, account TEXT NOT NULL, provider TEXT NOT NULL, label TEXT NOT NULL)")
            # Small dashboard-wide preferences (provider order), shared by every device.
            db.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS nicknames (file TEXT PRIMARY KEY, nickname TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS subscriptions (account TEXT PRIMARY KEY, terms TEXT NOT NULL)")
            # Silo cap state, keyed by the hub credential name the registry pauses. An owner's
            # per-account cap override, and the active-cap marker (reset time + its label).
            db.execute("CREATE TABLE IF NOT EXISTS cap_overrides (account TEXT PRIMARY KEY, cap_percent REAL NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS cap_state (account TEXT PRIMARY KEY, capped_until REAL, label TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '')")
            db.execute("CREATE TABLE IF NOT EXISTS cap_group_overrides (account TEXT NOT NULL, grp TEXT NOT NULL, cap_percent REAL NOT NULL, PRIMARY KEY(account, grp))")
            db.execute("CREATE TABLE IF NOT EXISTS cap_window_overrides (account TEXT NOT NULL, grp TEXT NOT NULL, win TEXT NOT NULL, cap_percent REAL NOT NULL, PRIMARY KEY(account, grp, win))")
            db.execute("CREATE TABLE IF NOT EXISTS cap_group_state (account TEXT NOT NULL, grp TEXT NOT NULL, capped_until REAL, label TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', PRIMARY KEY(account, grp))")
            for tbl in ("cap_state", "cap_group_state"):
                cols = {r[1] for r in db.execute(f"PRAGMA table_info({tbl})")}
                if "reason" not in cols:
                    db.execute(f"ALTER TABLE {tbl} ADD COLUMN reason TEXT NOT NULL DEFAULT ''")
            db.execute("CREATE TABLE IF NOT EXISTS weight_overrides (account TEXT PRIMARY KEY, weight REAL NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS plan_overrides (account TEXT PRIMARY KEY, plan TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS silo_activity (ts REAL, account TEXT, requests INTEGER, PRIMARY KEY(ts,account))")
            db.execute("CREATE INDEX IF NOT EXISTS silo_activity_time ON silo_activity(ts)")
            db.execute("CREATE TABLE IF NOT EXISTS machine_logins (node TEXT NOT NULL, slot TEXT NOT NULL, first_seen REAL NOT NULL, last_seen REAL NOT NULL, PRIMARY KEY(node, slot))")
            db.execute(
                "CREATE TABLE IF NOT EXISTS usage_file_state ("
                "path TEXT PRIMARY KEY, mtime_ns INTEGER NOT NULL, size INTEGER NOT NULL, source TEXT NOT NULL, "
                "session_id TEXT NOT NULL, cwd TEXT NOT NULL, parent_session_id TEXT NOT NULL, scanned_at REAL NOT NULL)"
            )
            db.execute(
                "CREATE TABLE IF NOT EXISTS usage_file_buckets ("
                "path TEXT NOT NULL, bucket_ts INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, "
                "requests INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, "
                "cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, "
                "PRIMARY KEY(path, bucket_ts, provider, model))"
            )
            db.execute("CREATE INDEX IF NOT EXISTS usage_file_buckets_time ON usage_file_buckets(bucket_ts)")
            self.migrate_codex_windows(db)

    @staticmethod
    def migrate_codex_windows(db):
        # Codex windows used to be keyed by slot; re-key stored readings by length (see codex_window_key).
        old = re.compile(r"(rate_limit|code_review_rate_limit):(primary|secondary)_window")
        for metric, period in db.execute("SELECT DISTINCT metric, period FROM samples WHERE provider='codex'").fetchall():
            match = old.fullmatch(metric)
            if match and period:
                db.execute("UPDATE OR REPLACE samples SET metric=? WHERE provider='codex' AND metric=? AND period=?",
                           (codex_window_key(match[1], None, period), metric, period))
        for account, data in db.execute("SELECT account, data FROM latest").fetchall():
            quota = json.loads(data)
            changed = False
            for w in quota.get("windows", []):
                match = old.fullmatch(str(w.get("id")))
                if match and w.get("period"):
                    w["id"] = codex_window_key(match[1], None, w["period"])
                    w["label"] = ("Code review · " if match[1] == "code_review_rate_limit" else "") + codex_window_label(w["period"])
                    changed = True
            if changed:
                db.execute("UPDATE latest SET data=? WHERE account=?", (json.dumps(quota), account))

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.path, timeout=15)
        try:
            connection.execute("PRAGMA synchronous=NORMAL")  # safe under WAL; only the last commits can be lost on power loss
            with connection:
                yield connection
        finally:
            connection.close()

    def load(self):
        with self.connect() as db:
            return {row[0]: json.loads(row[1]) for row in db.execute("SELECT account,data FROM latest")}

    def save(self, account, provider, quota):
        now = time.time()
        with self.version_lock:  # saves run from several cap workers; one of them claims each prune
            prune = now - self.pruned_at >= PRUNE_INTERVAL
            if prune:
                self.pruned_at = now
        try:
            with self.connect() as db:
                db.execute("INSERT OR REPLACE INTO latest VALUES (?,?)", (account, json.dumps(quota)))
                db.executemany("INSERT OR REPLACE INTO samples VALUES (?,?,?,?,?,?,?)", [
                    (quota["observed_at"], account, provider, w["id"], w["remaining"], w["reset_at"], w["period"])
                    for w in quota.get("windows", [])])
                if prune:
                    db.execute("DELETE FROM samples WHERE ts < ?", (now - HISTORY_RETENTION,))
        except Exception:
            if prune:
                with self.version_lock:
                    if self.pruned_at == now:
                        self.pruned_at = 0  # the prune was rolled back; let the next save retry it
            raise
        with self.version_lock:
            self.version += 1

    def add_session(self, token_hash, expires, key_hash):
        with self.connect() as db:
            db.execute("DELETE FROM sessions WHERE expires < ?", (time.time(),))
            db.execute("INSERT OR REPLACE INTO sessions VALUES (?,?,?)", (token_hash, expires, key_hash))

    def session(self, token_hash):
        with self.connect() as db:
            return db.execute("SELECT expires, key_hash FROM sessions WHERE token_hash = ?", (token_hash,)).fetchone()

    def renew_session(self, token_hash, expires):
        with self.connect() as db:
            db.execute("UPDATE sessions SET expires = ? WHERE token_hash = ?", (expires, token_hash))

    def record_machine_logins(self, pairs, now=None):
        """Record (node, slot) pairs observed logged in so 'Out' only appears for prior logins."""
        clean = sorted({(str(n), str(s)) for n, s in pairs if n and s})
        if not clean:
            return
        now = time.time() if now is None else float(now)
        with self.connect() as db:
            db.executemany(
                "INSERT INTO machine_logins(node, slot, first_seen, last_seen) VALUES (?,?,?,?) "
                "ON CONFLICT(node, slot) DO UPDATE SET last_seen=excluded.last_seen",
                [(n, s, now, now) for n, s in clean],
            )

    def machine_logins(self):
        """Return the set of (node, slot) pairs that have ever been observed logged in."""
        with self.connect() as db:
            return {(r[0], r[1]) for r in db.execute("SELECT node, slot FROM machine_logins")}

    def end_session(self, token_hash):
        with self.connect() as db:
            db.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))

    def get_setting(self, key, default=None):
        with self.connect() as db:
            row = db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def set_setting(self, key, value):
        with self.connect() as db:
            db.execute("INSERT OR REPLACE INTO settings VALUES (?,?)", (key, json.dumps(value)))

    def provider_order(self):
        order = self.get_setting("provider_order", [])
        return [p for p in order if isinstance(p, str)] if isinstance(order, list) else []

    def mypriors_subsidies(self):
        data = self.get_setting("mypriors_subsidies", None)
        return data if isinstance(data, dict) else None

    def save_mypriors_subsidies(self, data):
        self.set_setting("mypriors_subsidies", data)

    def save_live_buckets(self, buckets):
        with self.connect() as db:
            db.executemany("INSERT OR REPLACE INTO tokens_live VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                           (tuple(b[field] for field in LIVE_BUCKET_FIELDS) for b in buckets if b["hour"] is not None))

    def live_buckets(self, since=None, key_id=""):
        filters, args = [], []
        if since is not None:
            filters.append("hour>=?")
            args.append(since)
        if key_id:
            filters.append("key_id=?")
            args.append(key_id)
        where = " WHERE " + " AND ".join(filters) if filters else ""
        with self.connect() as db:
            rows = db.execute("SELECT " + ",".join(LIVE_BUCKET_FIELDS) + " FROM tokens_live" + where, args)
            return [dict(zip(LIVE_BUCKET_FIELDS, row)) for row in rows]

    def account_aliases(self):
        with self.connect() as db:
            return {auth_id: {"account": account, "provider": provider, "label": label}
                    for auth_id, account, provider, label in db.execute("SELECT auth_id,account,provider,label FROM account_aliases")}

    def save_account_aliases(self, mapping):
        with self.connect() as db:
            db.executemany("INSERT OR REPLACE INTO account_aliases VALUES (?,?,?,?)",
                           ((auth_id, *alias) for auth_id, alias in mapping.items()))

    def imported_buckets(self, since=None):
        """Token buckets imported from before Silo, shaped like the proxy's usage buckets."""
        where = "" if since is None else " WHERE hour>=?"
        with self.connect() as db:
            rows = db.execute("SELECT hour,provider,account,model,requests,failed,input_tokens,output_tokens,cache_read_tokens,"
                              "cache_write_tokens FROM tokens_imported" + where, () if since is None else (since,)).fetchall()
        return [{"key_id": "imported", "hour": r[0], "provider": r[1], "account": r[2], "model": r[3], "requests": r[4],
                 "failed": r[5], "input_tokens": r[6], "output_tokens": r[7], "cache_read_tokens": r[8],
                 "cache_write_tokens": r[9], "tokens": r[6] + r[7] + r[9]} for r in rows]

    def nicknames(self):
        with self.connect() as db:
            return dict(db.execute("SELECT file,nickname FROM nicknames"))

    def subscriptions(self, files=()):
        with self.connect() as db:
            terms = dict(db.execute("SELECT account,terms FROM subscriptions"))
            # Prefer existing account terms. Otherwise the first known filename wins.
            for raw in sorted(files, key=lambda f: f.get("name") or ""):
                old, key = raw.get("name"), subscription_key(raw)
                if old in terms and old != key:
                    db.execute("INSERT OR IGNORE INTO subscriptions SELECT ?,terms FROM subscriptions WHERE account=?", (key, old))
                    db.execute("DELETE FROM subscriptions WHERE account=?", (old,))
                    previous = terms.pop(old)
                    terms.setdefault(key, previous)
            return {key: json.loads(value) for key, value in terms.items()}

    def set_subscription(self, key, terms):
        with self.connect() as db:
            # A cleared stable key must also take precedence over legacy credentials
            # that are offline today and can only be migrated when they return.
            if terms is None and not key.startswith("codex-account:"):
                db.execute("DELETE FROM subscriptions WHERE account=?", (key,))
            else:
                db.execute("INSERT OR REPLACE INTO subscriptions VALUES (?,?)", (key, json.dumps(terms)))

    def set_nickname(self, file, nickname):
        with self.connect() as db:
            if nickname:
                db.execute("INSERT OR REPLACE INTO nicknames VALUES (?,?)", (file, nickname))
            else:
                db.execute("DELETE FROM nicknames WHERE file=?", (file,))

    def cap_overrides(self):
        with self.connect() as db:
            return dict(db.execute("SELECT account,cap_percent FROM cap_overrides"))

    def set_cap_override(self, account, cap_percent):
        with self.connect() as db:
            if cap_percent is None:
                db.execute("DELETE FROM cap_overrides WHERE account=?", (account,))
            else:
                db.execute("INSERT OR REPLACE INTO cap_overrides VALUES (?,?)", (account, cap_percent))

    def cap_group_overrides(self):
        out = {}
        with self.connect() as db:
            for account, group, cap in db.execute("SELECT account,grp,cap_percent FROM cap_group_overrides"):
                out.setdefault(account, {})[group] = cap
        return out

    def set_cap_group_override(self, account, grp, cap_percent):
        with self.connect() as db:
            if cap_percent is None:
                db.execute("DELETE FROM cap_group_overrides WHERE account=? AND grp=?", (account, grp))
            else:
                db.execute("INSERT OR REPLACE INTO cap_group_overrides VALUES (?,?,?)", (account, grp, cap_percent))

    def cap_window_overrides(self):
        out = {}
        with self.connect() as db:
            for account, grp, win, cap in db.execute("SELECT account,grp,win,cap_percent FROM cap_window_overrides"):
                out.setdefault(account, {})[(grp, win)] = cap
        return out

    def set_cap_window_override(self, account, grp, win, cap_percent):
        with self.connect() as db:
            if cap_percent is None:
                db.execute("DELETE FROM cap_window_overrides WHERE account=? AND grp=? AND win=?", (account, grp, win))
            else:
                db.execute("INSERT OR REPLACE INTO cap_window_overrides VALUES (?,?,?,?)", (account, grp, win, cap_percent))

    def clear_cap_window_overrides(self, account, grp=""):
        with self.connect() as db:
            db.execute("DELETE FROM cap_window_overrides WHERE account=? AND grp=?", (account, grp))

    def weight_overrides(self):
        with self.connect() as db:
            return {r[0]: float(r[1]) for r in db.execute("SELECT account,weight FROM weight_overrides")}

    def set_weight_override(self, account, weight):
        with self.connect() as db:
            if weight is None:
                db.execute("DELETE FROM weight_overrides WHERE account=?", (account,))
            else:
                db.execute("INSERT OR REPLACE INTO weight_overrides VALUES (?,?)", (account, weight))

    def plan_overrides(self):
        with self.connect() as db:
            return dict(db.execute("SELECT account,plan FROM plan_overrides"))

    def set_plan_override(self, account, plan):
        with self.connect() as db:
            if plan is None:
                db.execute("DELETE FROM plan_overrides WHERE account=?", (account,))
            else:
                db.execute("INSERT OR REPLACE INTO plan_overrides VALUES (?,?)", (account, plan))

    def cap_state(self):
        with self.connect() as db:
            out = {}
            for account, capped_until, label, reason in db.execute("SELECT account,capped_until,label,reason FROM cap_state"):
                row = {"capped_until": capped_until, "label": label}
                if reason:
                    row["reason"] = reason
                out[account] = row
            return out

    def set_cap_state(self, account, capped_until, label, reason=""):
        """Mark or clear an account's active Silo cap. capped_until None clears it."""
        with self.connect() as db:
            if capped_until is None and not label:
                db.execute("DELETE FROM cap_state WHERE account=?", (account,))
            else:
                db.execute("INSERT OR REPLACE INTO cap_state VALUES (?,?,?,?)", (account, capped_until, label, reason or ""))

    def cap_group_state(self):
        out = {}
        with self.connect() as db:
            for account, group, until, label, reason in db.execute("SELECT account,grp,capped_until,label,reason FROM cap_group_state"):
                row = {"capped_until": until, "label": label}
                if reason:
                    row["reason"] = reason
                out.setdefault(account, {})[group] = row
        return out

    def set_cap_group_state(self, account, grp, capped_until, label, reason=""):
        with self.connect() as db:
            if capped_until is None and not label:
                db.execute("DELETE FROM cap_group_state WHERE account=? AND grp=?", (account, grp))
            else:
                db.execute("INSERT OR REPLACE INTO cap_group_state VALUES (?,?,?,?,?)", (account, grp, capped_until, label, reason or ""))

    def clear_cap_group_state(self, account):
        with self.connect() as db:
            db.execute("DELETE FROM cap_group_state WHERE account=?", (account,))

    def save_cap_group_states(self, account, markers, clear_account_cap=False):
        with self.connect() as db:
            db.execute("DELETE FROM cap_group_state WHERE account=?", (account,))
            db.executemany("INSERT INTO cap_group_state VALUES (?,?,?,?,?)",
                           [(account, name, marker["capped_until"], marker["label"], marker.get("reason") or "") for name, marker in markers.items()])
            if clear_account_cap:
                db.execute("DELETE FROM cap_state WHERE account=?", (account,))

    def forget(self, account):
        """Drop an account's latest reading; its history samples stay for the charts."""
        with self.connect() as db:
            db.execute("DELETE FROM latest WHERE account=?", (account,))

    @staticmethod
    def bucket(hours):
        return max(120, hours * 3600 / HISTORY_POINTS)

    def history(self, hours=24):
        # Keep every sample on disk, but send each account's newest sample per bucket.
        # Providers are checked at different rates (Claude every 3 minutes), so picking
        # one cycle per bucket across all accounts would drop the slower ones.
        size = self.bucket(hours)
        with self.connect() as db:
            rows = db.execute(
                "WITH s AS (SELECT * FROM samples UNION ALL SELECT * FROM samples_imported), "
                "b AS (SELECT account a, MAX(ts) m FROM s WHERE ts>=? GROUP BY account, CAST(ts/? AS INTEGER)) "
                "SELECT ts,account,provider,metric,remaining,reset_at,period FROM s JOIN b ON account=b.a AND ts=b.m "
                "ORDER BY ts", (time.time() - hours * 3600, size)).fetchall()
        return [dict(zip(["ts", "account", "provider", "metric", "remaining", "reset_at", "period"], r)) for r in rows]

    def api_calibration(self, hub_accounts, priors_data=None):
        """Empirical Bayes calibration of API-equivalent USD per 100% of a 1x plan window.

        Uses only personal hub accounts (not shared Cyclone/Silo seats whose local laptop usage
        bypasses tokens_live) so external drain cannot bias the ratio downward. Each observed
        hour with both a non-reset quota drop and priced token usage contributes to its
        (provider, period_key) pool weighted by 1x-equivalent % drop."""
        by_id = {}
        file_to_id = {}
        for a in hub_accounts:
            aid = a.get("id")
            if not aid or a.get("silo"):
                continue
            by_id[aid] = {"provider": str(a.get("provider") or "").lower(),
                          "weight": float(a.get("weight") or 1.0)}
            fname = str(a.get("name") or "")
            if fname:
                file_to_id[fname] = aid
            file_to_id[aid] = aid

        hr_cost = {}  # (aid, hour, group_tag) -> usd
        samples_by_series = {}  # (prov, aid, metric) -> list[(ts, rem, reset_at, period)]
        if by_id:
            with self.connect() as db:
                for hour, prov, acct, model, inp, outp, cr, cw in db.execute(
                    "SELECT hour,provider,account,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens FROM tokens_live "
                    "UNION ALL "
                    "SELECT hour,provider,account,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens FROM tokens_imported"
                ):
                    aid = file_to_id.get(acct)
                    if not aid or hour is None:
                        continue
                    p = str(prov or by_id[aid]["provider"]).lower()
                    cost = bucket_api_cost(p, model, int(inp or 0), int(outp or 0), int(cr or 0), int(cw or 0))
                    if not cost or cost <= 0:
                        continue
                    hr = int(hour)
                    gtag = antigravity_model_group(model) if p == "antigravity" else ""
                    key = (aid, hr, gtag)
                    hr_cost[key] = hr_cost.get(key, 0.0) + cost

                placeholders = ",".join("?" for _ in by_id)
                id_list = tuple(by_id.keys())
                for ts, acct, prov, metric, rem, rst, per in db.execute(
                    f"SELECT ts,account,provider,metric,remaining,reset_at,period FROM samples WHERE account IN ({placeholders}) "
                    f"UNION ALL "
                    f"SELECT ts,account,provider,metric,remaining,reset_at,period FROM samples_imported WHERE account IN ({placeholders})",
                    id_list + id_list,
                ):
                    if _SCOPED_CALIBRATION_RE.search(str(metric or "")):
                        continue
                    samples_by_series.setdefault((str(prov or "").lower(), acct, str(metric or "")), []).append(
                        (float(ts), float(rem), rst, per))

        agg = {}  # key -> [cost_usd, norm_drop_1x_pct, matched_hours]
        for (prov, aid, metric), rows in samples_by_series.items():
            if len(rows) < 2:
                continue
            rows.sort(key=lambda r: r[0])
            weight = by_id[aid]["weight"]
            period = next((r[3] for r in rows if r[3]), None)
            pk = window_period_key(period)
            if pk == "other":
                continue
            gtag = antigravity_window_group(metric) if prov == "antigravity" else ""
            hr_drop = {}
            for i in range(1, len(rows)):
                t0, r0, rst0, _ = rows[i - 1]
                t1, r1, _, _ = rows[i]
                if t1 - t0 > 3600 or r1 > r0 + 0.5:
                    continue
                if rst0 and rst0 > t0 and rst0 <= t1:
                    continue
                drop = max(0.0, r0 - r1)
                if drop > 0:
                    hr = int(((t0 + t1) / 2.0) // 3600) * 3600
                    hr_drop[hr] = hr_drop.get(hr, 0.0) + drop
            for hr, drop in hr_drop.items():
                cost = hr_cost.get((aid, hr, gtag), 0.0)
                if cost <= 0:
                    continue
                for k in (((prov, pk, gtag), (prov, pk)) if gtag else ((prov, pk),)):
                    slot = agg.setdefault(k, [0.0, 0.0, 0])
                    slot[0] += cost
                    slot[1] += drop * weight
                    slot[2] += 1

        cal = {}
        live_priors = (priors_data or {}).get("priors_7d") or {}
        all_keys = set(DEFAULT_API_USD_PER_1X.keys()) | set(agg.keys())
        for k in all_keys:
            prov, pk = k[0], k[1]
            prior = default_api_usd_prior(prov, pk, priors_data=priors_data)
            cost, norm_drop, hrs = agg.get(k, (0.0, 0.0, 0))
            if norm_drop > 0:
                raw_obs = cost / (norm_drop / 100.0)
                clamped = max(prior * 0.1, min(prior * 10.0, raw_obs))
                blended = (CALIBRATION_PRIOR_PCT * prior + norm_drop * clamped) / (CALIBRATION_PRIOR_PCT + norm_drop)
                source = "calibrated" if norm_drop >= 50.0 else "blended"
            else:
                raw_obs = None
                blended = prior
                source = "estimate"
            cal[k] = {
                "usd_per_1x": round(blended, 2),
                "prior_usd": round(prior, 2),
                "prior_source": "mypriors" if prov in live_priors else "builtin",
                "obs_usd": round(raw_obs, 2) if raw_obs is not None else None,
                "obs_1x_drop": round(norm_drop, 1),
                "obs_cost": round(cost, 2),
                "obs_hours": hrs,
                "source": source,
            }
        return cal

    def save_silo_activity(self, ts, account, requests):
        with self.connect() as db:
            db.execute("INSERT OR REPLACE INTO silo_activity VALUES (?,?,?)", (ts, account, int(requests)))

    def silo_activity_samples(self, hours=24):
        size = self.bucket(hours)
        with self.connect() as db:
            rows = db.execute(
                "WITH b AS (SELECT account a, MAX(ts) m FROM silo_activity WHERE ts>=? GROUP BY account, CAST(ts/? AS INTEGER)) "
                "SELECT s.ts, s.account, s.requests FROM silo_activity s JOIN b ON s.account=b.a AND s.ts=b.m "
                "ORDER BY s.ts", (time.time() - hours * 3600, size)).fetchall()
        out = {}
        for ts, account, reqs in rows:
            out.setdefault(account, []).append([ts, reqs])
        return out

    def usage_file_states(self):
        with self.connect() as db:
            return {
                row[0]: {
                    "mtime_ns": int(row[1]),
                    "size": int(row[2]),
                    "source": row[3],
                    "session_id": row[4],
                    "cwd": row[5],
                    "parent_session_id": row[6],
                    "scanned_at": float(row[7]),
                }
                for row in db.execute(
                    "SELECT path,mtime_ns,size,source,session_id,cwd,parent_session_id,scanned_at FROM usage_file_state"
                )
            }

    def save_usage_files(self, records):
        """Upsert scanned file states and their 15-minute token buckets in one transaction."""
        if not records:
            return
        with self.connect() as db:
            for rec in records:
                path = rec["path"]
                db.execute(
                    "INSERT OR REPLACE INTO usage_file_state VALUES (?,?,?,?,?,?,?,?)",
                    (
                        path,
                        int(rec["mtime_ns"]),
                        int(rec["size"]),
                        rec["source"],
                        rec["session_id"],
                        rec["cwd"],
                        rec["parent_session_id"],
                        float(rec["scanned_at"]),
                    ),
                )
                db.execute("DELETE FROM usage_file_buckets WHERE path=?", (path,))
                rows = rec.get("buckets") or ()
                if rows:
                    db.executemany(
                        "INSERT OR REPLACE INTO usage_file_buckets VALUES (?,?,?,?,?,?,?,?,?)",
                        [
                            (
                                path,
                                int(b[0]),
                                b[1],
                                b[2],
                                int(b[3]),
                                int(b[4]),
                                int(b[5]),
                                int(b[6]),
                                int(b[7]),
                            )
                            for b in rows
                        ],
                    )

    def prune_usage_files(self, live_paths, min_bucket_ts):
        """Remove buckets older than retention and files no longer present on disk."""
        live = set(live_paths)
        with self.connect() as db:
            db.execute("DELETE FROM usage_file_buckets WHERE bucket_ts < ?", (int(min_bucket_ts),))
            existing = [row[0] for row in db.execute("SELECT path FROM usage_file_state")]
            stale = [p for p in existing if p not in live]
            if stale:
                db.executemany("DELETE FROM usage_file_buckets WHERE path=?", [(p,) for p in stale])
                db.executemany("DELETE FROM usage_file_state WHERE path=?", [(p,) for p in stale])

    def usage_file_buckets(self, since_ts):
        with self.connect() as db:
            return db.execute(
                "SELECT s.path, s.source, s.session_id, s.cwd, s.parent_session_id, "
                "b.bucket_ts, b.provider, b.model, b.requests, b.input_tokens, b.output_tokens, "
                "b.cache_read_tokens, b.cache_write_tokens "
                "FROM usage_file_buckets b JOIN usage_file_state s ON s.path = b.path "
                "WHERE b.bucket_ts >= ?",
                (int(since_ts),),
            ).fetchall()

    def update_usage_file_parents(self, parent_map):
        if not parent_map:
            return
        with self.connect() as db:
            db.executemany(
                "UPDATE usage_file_state SET parent_session_id=? "
                "WHERE source='antigravity' AND lower(session_id)=? AND parent_session_id=''",
                [(parent_id, child_id.lower()) for child_id, parent_id in parent_map.items()],
            )
