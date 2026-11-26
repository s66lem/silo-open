import contextlib
import copy
import gzip
import http.client
import json
import os
import re
import sqlite3
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import call, patch

import api_pricing
import history_store
import quota_readers
import server as dashboard_server
import silo_accounts
from quota_readers import parse_claude_resets
from server import (ERROR_LOG_LIMIT, Handler, Hub, ProxyError, Store, ThreadingHTTPServer, parse_antigravity, parse_claude,
                    parse_claude_plan, parse_codex, parse_codex_resets, parse_devin, parse_xai,
                    safe_account)


class QuotaTests(unittest.TestCase):
    def test_codex_preserves_real_window_and_zero_quota(self):
        result = parse_codex({"plan_type": "go", "rate_limit": {
            "primary_window": {"used_percent": 100, "limit_window_seconds": 2592000, "reset_at": 1797106147},
            "secondary_window": None}})
        self.assertEqual(result["plan"], "go")
        self.assertEqual(len(result["windows"]), 1)
        self.assertEqual(result["windows"][0]["remaining"], 0)
        self.assertEqual(result["windows"][0]["period"], 2592000)

    def test_claude_plan_names_the_plan_and_seat(self):
        cases = [
            ({"organization_type": "claude_team", "seat_tier": "team_standard", "rate_limit_tier": "default_raven"}, "Team · Standard"),
            ({"organization_type": "claude_team", "seat_tier": "team_premium"}, "Team · Premium"),
            ({"organization_type": "claude_team", "seat_tier": "team_tier_1", "rate_limit_tier": "default_claude_max_5x"}, "Team · Premium"),
            ({"organization_type": "claude_enterprise"}, "Enterprise"),
            ({"organization_type": "claude_max", "rate_limit_tier": "default_claude_max_20x"}, "Max 20x"),
            ({"organization_type": "claude_max", "rate_limit_tier": "default_claude_max_5x"}, "Max 5x"),
            ({"organization_type": "claude_pro"}, "Pro"),
            ({}, None)]
        for org, plan in cases:
            self.assertEqual(parse_claude_plan({"organization": org}), plan, org)

    def test_claude_plan_is_read_rarely_and_kept_when_a_read_fails(self):
        with tempfile.TemporaryDirectory() as folder:
            hub = Hub(Store(Path(folder) / "history.sqlite"))
            raw = {"auth_index": "c1", "provider": "claude"}
            team = (200, {"organization": {"organization_type": "claude_team", "seat_tier": "team_premium"}})
            with patch.object(hub, "call", return_value=team) as call:
                self.assertEqual(hub.claude_plan(raw), "Team · Premium")
                hub.quotas["c1"] = {"plan": "Team · Premium"}
                self.assertEqual(hub.claude_plan(raw), "Team · Premium")
            call.assert_called_once()
            hub.plan_reads["c1"] = 0
            with patch.object(hub, "call", return_value=(500, None)):
                self.assertEqual(hub.claude_plan(raw), "Team · Premium")
    def test_codex_windows_are_keyed_by_length_across_plans(self):
        plus = parse_codex({"plan_type": "plus", "rate_limit": {
            "primary_window": {"used_percent": 86, "limit_window_seconds": 18000},
            "secondary_window": {"used_percent": 13, "limit_window_seconds": 604800}}})
        pro = parse_codex({"plan_type": "prolite", "rate_limit": {
            "primary_window": {"used_percent": 55, "limit_window_seconds": 604800}, "secondary_window": None}})
        self.assertEqual([(w["id"], w["label"]) for w in plus["windows"]],
                         [("rate_limit:5h", "5-hour limit"), ("rate_limit:7d", "Weekly limit")])
        # Pro's only limit is weekly, so it pools with Plus's weekly limit, not its 5-hour one.
        self.assertEqual([(w["id"], w["label"], w["remaining"]) for w in pro["windows"]],
                         [("rate_limit:7d", "Weekly limit", 45)])

    def test_store_rekeys_codex_slot_history_by_length(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "quota.sqlite"
            with contextlib.closing(sqlite3.connect(path)) as db, db:
                db.execute("CREATE TABLE samples (ts REAL, account TEXT, provider TEXT, metric TEXT, remaining REAL, reset_at REAL, period REAL, PRIMARY KEY(ts,account,metric))")
                db.execute("CREATE TABLE latest (account TEXT PRIMARY KEY, data TEXT)")
                db.executemany("INSERT INTO samples VALUES (?,?,?,?,?,?,?)", [
                    (1, "plus", "codex", "rate_limit:primary_window", 14, None, 18000),
                    (1, "plus", "codex", "rate_limit:secondary_window", 87, None, 604800),
                    (1, "pro", "codex", "rate_limit:primary_window", 45, None, 604800),
                    (1, "c", "claude", "five_hour", 100, None, 18000)])
                db.execute("INSERT INTO latest VALUES (?,?)", ("pro", json.dumps({"windows": [
                    {"id": "rate_limit:primary_window", "label": "Usage · 7 days", "period": 604800}]})))
            store = Store(path)
            with contextlib.closing(sqlite3.connect(path)) as db, db:
                self.assertEqual(sorted(db.execute("SELECT account, metric FROM samples")), [
                    ("c", "five_hour"), ("plus", "rate_limit:5h"), ("plus", "rate_limit:7d"), ("pro", "rate_limit:7d")])
            self.assertEqual(store.load()["pro"]["windows"][0], {"id": "rate_limit:7d", "label": "Weekly limit", "period": 604800})
            Store(path)  # A second start finds nothing left to move.

    def test_missing_codex_percent_is_unknown(self):
        self.assertEqual(parse_codex({"rate_limit": {"primary_window": {"reset_at": 123}}})["windows"], [])

    def test_antigravity_reads_shared_group_limits(self):
        result = parse_antigravity({"groups": [
            {"displayName": "Gemini Models", "buckets": [
                {"bucketId": "gemini-weekly", "window": "weekly", "remainingFraction": 1},
                {"bucketId": "gemini-5h", "window": "5h", "remainingFraction": 0, "resetTime": "2026-11-13T23:17:58Z"},
                {"bucketId": "gemini-unknown", "window": "weekly"}]},
            {"displayName": "Claude and GPT models", "buckets": [
                {"bucketId": "3p-daily", "window": "daily", "displayName": "Daily Limit Remaining", "remainingFraction": 0.5}]}]})
        self.assertEqual([(w["id"], w["group"], w["label"], w["remaining"], w["period"]) for w in result["windows"]], [
            ("gemini-5h", "Gemini", "Gemini · 5-hour limit", 0, 5 * 3600),
            ("gemini-weekly", "Gemini", "Gemini · Weekly limit", 100, 7 * 86400),
            ("3p-daily", "Claude & GPT", "Claude & GPT · Daily Limit", 50, None)])
        self.assertIsNotNone(result["windows"][0]["reset_at"])

    def test_claude_reads_utilization_and_skips_null_windows(self):
        result = parse_claude({
            "five_hour": {"utilization": 68.0, "resets_at": "2026-11-13T18:00:00+00:00"},
            "seven_day": {"utilization": 100, "resets_at": "2026-11-18T00:00:00Z"},
            "seven_day_opus": None, "seven_day_sonnet": {"utilization": None}})
        self.assertEqual([(w["id"], w["remaining"]) for w in result["windows"]], [("five_hour", 32.0), ("seven_day", 0.0)])
        self.assertEqual(result["windows"][0]["period"], 5 * 3600)
        self.assertIsNotNone(result["windows"][1]["reset_at"])

    def test_claude_reads_new_model_windows_without_a_code_change(self):
        result = parse_claude({
            "five_hour": {"utilization": 10}, "seven_day": {"utilization": 20},
            "seven_day_opus": {"utilization": 40}, "seven_day_oauth_apps": {"utilization": 50},
            "extra_usage": {"utilization": 60}, "iguana_necktie": {"utilization": 70},
            "limits": [
                {"kind": "weekly_scoped", "scope": {"model": {"display_name": "Fable 5"}}, "percent": 90, "is_active": False},
                {"kind": "weekly_scoped", "scope": {"model": {"display_name": "Fable 5"}}, "percent": 30, "is_active": True},
                {"kind": "session", "percent": 5}]})
        self.assertEqual([(w["id"], w["label"], w["remaining"]) for w in result["windows"]], [
            ("five_hour", "5-hour limit", 90), ("seven_day", "Weekly limit", 80),
            ("seven_day_opus", "Weekly · Opus", 60), ("weekly_scoped:fable_5", "Weekly · Fable 5", 70)])
        self.assertEqual(result["windows"][3]["period"], 7 * 86400)

    def test_claude_codename_window_is_fable_unless_it_is_cloud_credits(self):
        fable = parse_claude({"iguana_necktie": {"utilization": 25}})["windows"]
        self.assertEqual([(w["label"], w["remaining"]) for w in fable], [("Weekly · Fable 5", 75)])
        self.assertEqual(parse_claude({"iguana_necktie": {"utilization": 25, "limit_dollars": 50}})["windows"], [])

    def test_claude_rejects_malformed_present_windows(self):
        for bad in ("invalid", True, [1]):
            with self.assertRaises(ValueError):
                parse_claude({"five_hour": {"utilization": 10}, "seven_day": {"utilization": bad}})

    def test_devin_parses_daily_weekly_quota_and_plan_period(self):
        result = parse_devin({"quota": {"signals": {
            "plan": "Pro",
            "daily_quota_remaining_percent": "0%",
            "weekly_quota_remaining_percent": "45",
            "daily_quota_reset_at": "2026-11-21T00:00:00Z",
            "weekly_quota_reset_at": "2026-11-27T00:00:00Z",
            "plan_start": "2026-11-01T00:00:00Z",
            "plan_end": "2026-12-01T00:00:00Z",
        }}})
        self.assertEqual(result["plan"], "Pro")
        self.assertEqual([(w["id"], w["label"], w["remaining"], w["period"]) for w in result["windows"]], [
            ("daily", "Daily limit", 0.0, 86400),
            ("weekly", "Weekly limit", 45.0, 7 * 86400),
        ])
        self.assertIsNotNone(result["windows"][0]["reset_at"])
        self.assertIsNotNone(result["windows"][1]["reset_at"])
        self.assertEqual(result["profile"]["subscription_until"] - result["profile"]["subscription_started"], 30 * 86400)
        self.assertEqual(parse_devin({"quota": {"signals": {}}})["windows"], [])
        for bad in ("bad%", True, [1]):
            with self.assertRaises(ValueError):
                parse_devin({"quota": {"signals": {"daily_quota_remaining_percent": bad}}})

    def test_devin_quota_refreshes_through_proxy_and_pools_into_totals(self):
        with tempfile.TemporaryDirectory() as folder:
            hub = Hub(Store(Path(folder) / "history.sqlite"))
            raw = {"auth_index": "d1", "name": "devin-alice.json", "provider": "devin", "email": "alice@example.com"}
            refreshed = {"ok": True, "auth": {**raw, "quota": {"observed_at": "2026-11-20T22:00:00Z", "signals": {
                "plan": "Pro", "daily_quota_remaining_percent": "80%", "weekly_quota_remaining_percent": "60%",
                "daily_quota_reset_at": "2026-11-21T00:00:00Z", "weekly_quota_reset_at": "2026-11-27T00:00:00Z",
                "plan_start": "2026-11-01T00:00:00Z", "plan_end": "2026-12-01T00:00:00Z"}}}}
            now = time.time()
            with patch.object(hub, "request", return_value=refreshed) as req:
                hub.refresh_one(raw, observed_at=now - 60)
            req.assert_called_once_with("credentials/refresh", {"name": "devin-alice.json", "auth_index": "d1"}, "POST")
            hub.files = [raw]
            snap = hub.snapshot(24)
            acct = snap["accounts"][0]
            self.assertEqual(acct["plan"], "Pro")
            self.assertEqual([(w["id"], w["remaining"]) for w in acct["windows"]], [("daily", 80.0), ("weekly", 60.0)])
            self.assertIsNotNone(acct["detail"]["provider_fields"]["subscription_until"])
            self.assertEqual([p["value"] for p in snap["totals"]["devin"]["daily"]], [80.0])
            self.assertEqual([p["value"] for p in snap["totals"]["devin"]["weekly"]], [60.0])
            self.assertEqual(snap["totals"]["all"]["5h"]["metrics"], {"devin": "daily"})
            self.assertEqual([p["value"] for p in snap["totals"]["all"]["5h"]["points"]], [80.0])
            self.assertEqual(snap["totals"]["all"]["7d"]["metrics"], {"devin": "weekly"})
            self.assertEqual([p["value"] for p in snap["totals"]["all"]["7d"]["points"]], [60.0])

    def test_devin_uses_observed_quota_fallback_before_poll_and_on_error(self):
        with tempfile.TemporaryDirectory() as folder:
            hub = Hub(Store(Path(folder) / "history.sqlite"))
            raw = {"auth_index": "d1", "name": "devin-alice.json", "provider": "devin", "disabled": True,
                   "quota": {"observed_at": "2026-11-20T21:00:00Z", "signals": {
                       "plan": "Pro", "daily_quota_remaining_percent": "75%", "weekly_quota_remaining_percent": "50%"}}}
            hub.files = [raw]
            # Even when paused / before first poll, the credential's existing observation is shown.
            acct = hub.snapshot(24)["accounts"][0]
            self.assertEqual([(w["id"], w["remaining"]) for w in acct["windows"]], [("daily", 75.0), ("weekly", 50.0)])
            self.assertIsNotNone(acct["quota_at"])
            # When an active refresh fails, the last observed quota is kept alongside the error.
            active = {**raw, "disabled": False}
            with patch.object(hub, "request", side_effect=ProxyError(500, b"boom")):
                hub.refresh_one(active)
            self.assertEqual([(w["id"], w["remaining"]) for w in hub.quotas["d1"]["windows"]], [("daily", 75.0), ("weekly", 50.0)])
            self.assertIn("HTTP 500", hub.quotas["d1"]["error"])

    def test_every_provider_is_listed_but_only_quota_providers_are_checked(self):
        with tempfile.TemporaryDirectory() as folder:
            hub = Hub(Store(Path(folder) / "history.sqlite"))
            files = [{"auth_index": "c", "provider": "claude"}, {"auth_index": "x", "provider": "xai", "account_type": "api_key"},
                     {"auth_index": "k", "provider": "kimi"}]
            with patch.object(hub, "request", return_value={"files": files}):
                self.assertEqual([f["auth_index"] for f in hub.read_files()], ["c", "x", "k"])
            with patch.object(hub, "fetch_quota", return_value={"windows": [], "observed_at": 1}) as fetch:
                hub.refresh_one(files[1])
                hub.refresh_one(files[2])
                fetch.assert_not_called()
                hub.refresh_one(files[0])
                fetch.assert_called_once()

    def test_disabled_accounts_keep_being_read_so_their_history_continues(self):
        with tempfile.TemporaryDirectory() as folder:
            hub = Hub(Store(Path(folder) / "history.sqlite"))
            raw = {"auth_index": "x", "name": "xai.json", "provider": "xai", "account_type": "oauth", "disabled": True}
            quota = {"windows": [{"id": "credits", "label": "Weekly credits", "remaining": 91.0, "reset_at": None,
                                  "period": 7 * 86400}], "observed_at": time.time()}
            with patch.object(hub, "fetch_quota", return_value=quota) as fetch, patch.object(hub, "xai_plan", return_value=None):
                hub.refresh_one(raw)
            fetch.assert_called_once_with(raw)
            self.assertEqual(hub.quotas["x"]["windows"][0]["remaining"], 91.0)
            self.assertEqual([r["remaining"] for r in hub.store.history(24) if r["account"] == "x"], [91.0])

    def test_xai_parses_product_only_usage_without_inventing_shared_credits(self):
        quota = parse_xai({"current_period": {"type": "weekly"}, "credit_usage_percent": True,
                           "product_usage": [{"product": "GrokBot", "usage_percent": "0"},
                                             {"product": "Unknown", "usage_percent": "bad"}]})
        self.assertEqual(quota["windows"], [{"id": "product:grokbot", "label": "GrokBot", "remaining": 100.0,
                                             "reset_at": None, "period": 7 * 86400}])
        account = {"provider": "xai", "windows": quota["windows"]}
        self.assertEqual(Hub.all_totals([account], [], 900)["7d"]["metrics"], {})

    def test_xai_oauth_quota_reaches_accounts_and_quota_history(self):
        with tempfile.TemporaryDirectory() as folder:
            hub = Hub(Store(Path(folder) / "history.sqlite"))
            raw = {"auth_index": "x1", "name": "xai-grok.json", "provider": "xai", "account_type": "oauth"}
            usage = {"config": {
                "creditUsagePercent": 35,
                "currentPeriod": {"type": "USAGE_PERIOD_TYPE_WEEKLY", "end": "2026-11-28T03:44:32Z"},
                "productUsage": [{"product": "GrokBot", "usagePercent": 100}],
            }}
            responses = [
                {"status_code": 200, "body": json.dumps(usage)},
                {"status_code": 200, "body": json.dumps({"subscriptionTier": "GrokPro"})},
            ]
            hub.files = [raw]
            with patch.object(hub, "request", side_effect=responses) as req:
                hub.refresh_one(raw)
                hub.refresh_one(raw)
            payloads = [c.args[1] for c in req.call_args_list]
            self.assertEqual([p["url"] for p in payloads], [
                "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
                "https://cli-chat-proxy.grok.com/v1/user?include=subscription",
            ])
            for c, payload in zip(req.call_args_list, payloads):
                self.assertEqual(c.args[0], "requests/api-call")
                self.assertEqual(payload["auth_index"], "x1")
                self.assertEqual(payload["method"], "GET")
                self.assertEqual(payload["header"]["Authorization"], "Bearer $TOKEN$")
            snap = hub.snapshot(24)
            account = snap["accounts"][0]
            self.assertEqual(account["plan"], "SuperGrok")
            self.assertEqual([(w["id"], w["remaining"]) for w in account["windows"]],
                             [("credits", 65.0), ("product:grokbot", 0.0)])
            self.assertIsNotNone(account["windows"][0]["reset_at"])
            self.assertEqual([p["value"] for p in snap["totals"]["xai"]["credits"]], [65.0])
            self.assertEqual(snap["totals"]["all"]["7d"]["metrics"], {"xai": "credits"})

            hub.quota_attempts.clear()
            with patch.object(hub, "request", return_value={"status_code": 429}) as req:
                hub.refresh_one(raw)
            req.assert_called_once()
            failed = hub.snapshot(24)["accounts"][0]
            self.assertEqual(failed["windows"], account["windows"])
            self.assertIn("HTTP 429", failed["quota_error"])

    def test_claude_quota_checks_respect_its_slower_interval(self):
        with tempfile.TemporaryDirectory() as folder:
            hub = Hub(Store(Path(folder) / "history.sqlite"))
            claude, codex = {"auth_index": "c", "provider": "claude"}, {"auth_index": "x", "provider": "codex"}
            with patch.object(hub, "fetch_quota", return_value={"windows": [], "observed_at": 1}) as fetch, \
                    patch.object(hub, "codex_resets", return_value=None):
                for _ in range(3):
                    hub.refresh_one(claude)
                    hub.refresh_one(codex)
            self.assertEqual([c.args[0]["provider"] for c in fetch.call_args_list].count("claude"), 1)
            self.assertEqual([c.args[0]["provider"] for c in fetch.call_args_list].count("codex"), 1)
            hub.quota_attempts["c"] -= 360
            with patch.object(hub, "fetch_quota", return_value={"windows": [], "observed_at": 2}) as fetch:
                hub.refresh_one(claude)
                fetch.assert_called_once()

    def test_failed_quota_reads_retry_with_short_backoff_then_reset_on_success(self):
        with tempfile.TemporaryDirectory() as folder:
            hub = Hub(Store(Path(folder) / "history.sqlite"))
            codex = {"auth_index": "x", "provider": "codex"}
            t = [10_000.0]
            with patch.object(dashboard_server.time, "time", side_effect=lambda: t[0]), \
                    patch.object(hub, "codex_resets", return_value=None):
                with patch.object(hub, "fetch_quota", side_effect=ValueError("HTTP 502")) as fetch:
                    hub.refresh_one(codex)
                    self.assertEqual(fetch.call_count, 1)
                    # Too soon after 1st failure (< 60s): skipped.
                    t[0] += 59
                    hub.refresh_one(codex)
                    self.assertEqual(fetch.call_count, 1)
                    # At 60s: retries (2nd failure).
                    t[0] += 1
                    hub.refresh_one(codex)
                    self.assertEqual(fetch.call_count, 2)
                    # Backoff doubles to 120s after 2nd failure.
                    t[0] += 119
                    hub.refresh_one(codex)
                    self.assertEqual(fetch.call_count, 2)
                    t[0] += 1
                    hub.refresh_one(codex)
                    self.assertEqual(fetch.call_count, 3)
                # After 3rd failure backoff is 240s; once it succeeds, backoff resets to full interval (>= 300s).
                t[0] += 240
                with patch.object(hub, "fetch_quota", return_value={"windows": [], "observed_at": t[0]}) as fetch:
                    hub.refresh_one(codex)
                    self.assertEqual(fetch.call_count, 1)
                    t[0] += 299
                    hub.refresh_one(codex)
                    self.assertEqual(fetch.call_count, 1)
                    t[0] += 61
                    hub.refresh_one(codex)
                    self.assertEqual(fetch.call_count, 2)

    def test_failed_remote_quota_reads_retry_with_short_backoff(self):
        with tempfile.TemporaryDirectory() as folder:
            hub = Hub(Store(Path(folder) / "history.sqlite"))
            entry = silo_entry("c1", "codex")
            now = 20_000.0
            with patch.object(Hub, "fetch_remote_quota", side_effect=ValueError("Laptop unreachable")) as fetch:
                hub.remote_usage(entry, now)
                self.assertEqual(fetch.call_count, 1)
                # Cached under 60s after 1st failure.
                hub.remote_usage(entry, now + 59)
                self.assertEqual(fetch.call_count, 1)
                # Retries at 60s (2nd failure -> 120s backoff).
                hub.remote_usage(entry, now + 60)
                self.assertEqual(fetch.call_count, 2)
                hub.remote_usage(entry, now + 179)
                self.assertEqual(fetch.call_count, 2)
                hub.remote_usage(entry, now + 180)
                self.assertEqual(fetch.call_count, 3)
            # Recovery resets back to normal >= 300s interval.
            with patch.object(Hub, "fetch_remote_quota", return_value=(25.0, now + 7200)) as fetch:
                hub.remote_usage(entry, now + 420)
                self.assertEqual(fetch.call_count, 1)
                hub.remote_usage(entry, now + 420 + 299)
                self.assertEqual(fetch.call_count, 1)
                hub.remote_usage(entry, now + 420 + 360)
                self.assertEqual(fetch.call_count, 2)

    def test_codex_resets_list_available_credits_soonest_first(self):
        result = parse_codex_resets({"available_count": 2, "credits": [
            {"id": "b", "reset_type": "codex_rate_limits", "status": "available", "title": "Full reset", "expires_at": "2026-12-02T00:00:00Z"},
            {"id": "a", "reset_type": "codex_rate_limits", "status": "available", "expires_at": "2026-12-01T00:00:00Z"},
            {"id": "used", "reset_type": "codex_rate_limits", "status": "redeemed", "expires_at": "2026-12-01T00:00:00Z"},
            {"id": "other", "reset_type": "something_else", "status": "available", "expires_at": "2026-12-01T00:00:00Z"},
            {"id": "expired", "reset_type": "codex_rate_limits", "status": "available", "expires_at": 1},
            {"id": "spent", "reset_type": "codex_rate_limits", "status": "available", "redeemed_at": 1, "expires_at": 10}]}, now=5)
        self.assertEqual(result["available"], 2)
        self.assertEqual([(i["id"], i["label"]) for i in result["items"]], [("a", "Full reset"), ("b", "Full reset")])

    def test_claude_grants_explain_why_a_reset_cannot_be_used(self):
        grant = {"id": "g1", "label": "One full\nlimit reset", "resets_total": 1, "resets_left": 1, "usable_now": True,
                 "ends_at": "2030-01-01T00:00:00Z"}
        status = {"eligible": True, "at_limit": False, "grants": [grant, {"id": "BAD ID", "resets_total": 1, "resets_left": 1}]}
        result = parse_claude_resets(status, now=0)
        self.assertEqual(result["available"], 1)
        self.assertEqual([(i["id"], i["label"], i["reason"]) for i in result["items"]],
                         [("g1", "One full limit reset", "Usable once the account hits a limit")])
        self.assertIsNone(parse_claude_resets({**status, "at_limit": True}, now=0)["items"][0]["reason"])
        self.assertEqual(parse_claude_resets({**status, "eligible": False}, now=0)["items"][0]["reason"], "Not available for this account")
        self.assertIsNone(parse_claude_resets({"grants": []}))
        self.assertEqual(parse_claude({"five_hour": {"utilization": 1}, "cedar_ember": status})["resets"]["available"], 1)

    def reset_hub(self, folder, provider, resets):
        hub = Hub(Store(Path(folder) / "history.sqlite"))
        raw = {"auth_index": "r", "provider": provider}
        hub.quotas["r"] = {"windows": [], "resets": resets}
        return hub, raw

    def test_codex_reset_spends_the_chosen_credit_then_clears_cooldown(self):
        credits = {"available": 2, "items": [{"id": "soon"}, {"id": "later"}]}
        with tempfile.TemporaryDirectory() as folder:
            hub, raw = self.reset_hub(folder, "codex", credits)
            with patch.object(hub, "fetch_codex_resets", return_value=credits), \
                    patch.object(hub, "call", return_value=(200, {"code": "reset"})) as call, \
                    patch.object(hub, "request") as request, patch.object(hub, "refresh_one") as refresh:
                hub.use_reset(raw, "later")
                hub.use_reset(raw)
            self.assertTrue(call.call_args_list[0].args[2].endswith("/consume"))
            self.assertEqual([c.args[4]["credit_id"] for c in call.call_args_list], ["later", "soon"])
            self.assertNotEqual(*[c.args[4]["redeem_request_id"] for c in call.call_args_list])
            request.assert_called_with("routing/cooldown/reset", {"auth_index": "r"}, "POST")
            self.assertEqual(refresh.call_count, 2)
            with patch.object(hub, "fetch_codex_resets", return_value=credits), patch.object(hub, "call") as call:
                with self.assertRaisesRegex(ValueError, "no longer on the account"):
                    hub.use_reset(raw, "gone")
                call.assert_not_called()

    def test_codex_reset_retries_an_unknown_outcome_and_keeps_unspent_resets(self):
        credits = {"available": 1, "items": [{"id": "soon"}]}
        with tempfile.TemporaryDirectory() as folder:
            hub, raw = self.reset_hub(folder, "codex", credits)
            with patch.object(hub, "fetch_codex_resets", return_value=credits) as fetch, \
                    patch.object(hub, "call", side_effect=[(502, None), (200, {"code": "already_redeemed"})]) as call, \
                    patch.object(hub, "request"), patch.object(hub, "refresh_one"):
                with self.assertRaisesRegex(ValueError, "outcome is unknown"):
                    hub.use_reset(raw, "soon")
                hub.use_reset(raw, "soon")
            first, second = [c.args[4] for c in call.call_args_list]
            self.assertEqual(first, second)
            fetch.assert_called_once()
            self.assertEqual(hub.reset_claims, {})
            with patch.object(hub, "fetch_codex_resets", return_value=credits), \
                    patch.object(hub, "call", return_value=(200, {"code": "nothing_to_reset"})), \
                    self.assertRaisesRegex(ValueError, "reset was kept"):
                hub.use_reset(raw, "soon")
            self.assertEqual(hub.reset_claims, {})

    def test_claude_reset_retries_an_unknown_outcome_with_the_same_request(self):
        org = "12345678-1234-1234-1234-123456789abc"
        grant = {"id": "g1", "left": 1, "total": 1, "reason": None}
        with tempfile.TemporaryDirectory() as folder:
            hub, raw = self.reset_hub(folder, "claude", {"available": 1, "items": [grant]})
            profile = (200, {"organization": {"uuid": org}})
            with patch.object(hub, "call", side_effect=[profile, (502, None), profile, (200, {"result": "reset"})]) as call, \
                    patch.object(hub, "request"):
                with self.assertRaisesRegex(ValueError, "outcome is unknown"):
                    hub.use_reset(raw, "g1")
                hub.use_reset(raw, "g1")
            claims = [c.args[4] for c in call.call_args_list if c.args[1] == "POST"]
            self.assertEqual(claims[0]["request_id"], claims[1]["request_id"])
            self.assertEqual(claims[0], {"program": "cedar_ember", "grant_id": "g1", "request_id": claims[0]["request_id"]})
            self.assertIn(f"/api/organizations/{org}/reset_rate_limits", call.call_args_list[1].args[2])
            self.assertEqual(hub.quotas["r"]["resets"]["available"], 0)
            self.assertEqual(hub.reset_claims, {})

    def test_claude_reset_refuses_blocked_or_declined_grants(self):
        org = "12345678-1234-1234-1234-123456789abc"
        with tempfile.TemporaryDirectory() as folder:
            hub, raw = self.reset_hub(folder, "claude", {"available": 1, "items": [
                {"id": "g1", "left": 1, "total": 1, "reason": "Usable once the account hits a limit"}]})
            with patch.object(hub, "call") as call, self.assertRaisesRegex(ValueError, "can't be used now"):
                hub.use_reset(raw, "g1")
            call.assert_not_called()
            hub.quotas["r"]["resets"]["items"][0]["reason"] = None
            with patch.object(hub, "call", side_effect=[(200, {"organization": {"uuid": org}}), (200, {"result": "not_limited"})]), \
                    self.assertRaisesRegex(ValueError, "no reset was used"):
                hub.use_reset(raw, "g1")
            self.assertEqual(hub.quotas["r"]["resets"]["available"], 1)

    def test_refresh_grant_rejection_requires_sign_in(self):
        raw = {"auth_index": "a", "provider": "claude", "requires_sign_in": False,
               "unavailable": True, "renewal_state": "retry_scheduled"}
        for code, expected in [("invalid_grant", True), ("rate_limit_error", False)]:
            with self.subTest(code=code):
                self.assertEqual(safe_account({**raw, "refresh_error": {"code": code}})["requires_sign_in"], expected)

    def test_raw_credentials_are_not_relayed(self):
        raw = {"auth_index": "a", "provider": "codex", "access_token": "secret-token",
               "id_token": {"chatgpt_account_id": "private-id", "plan_type": "go"},
               "path": "/secret-path", "status_message": "secret-token", "refresh_token": "secret-refresh"}
        result = json.dumps(safe_account(raw))
        for value in ["secret-token", "private-id", "secret-path", "secret-refresh", "id_token"]:
            self.assertNotIn(value, result)

    def test_failed_refresh_preserves_last_observation_without_new_sample(self):
        with tempfile.TemporaryDirectory() as folder:
            store = Store(Path(folder) / "history.sqlite")
            hub = Hub(store)
            before = {"observed_at": time.time() - 600, "plan": "go", "windows": [
                {"id": "primary", "label": "Monthly", "remaining": 50, "reset_at": None, "period": 2592000}]}
            hub.quotas["a"] = before
            store.save("a", "codex", before)
            with patch.object(hub, "fetch_quota", side_effect=ValueError("Quota unavailable")):
                hub.refresh_one({"auth_index": "a", "provider": "codex"})
            self.assertEqual(hub.quotas["a"]["observed_at"], before["observed_at"])
            self.assertEqual(hub.quotas["a"]["windows"][0]["remaining"], 50)
            self.assertEqual(len(store.history()), 1)
            self.assertIn("error", hub.quotas["a"])

    def test_history_keeps_every_accounts_newest_sample_per_bucket(self):
        with tempfile.TemporaryDirectory() as folder:
            store = Store(Path(folder) / "history.sqlite")
            base = (time.time() // 600) * 600 - 3600  # start of an old bucket
            window = lambda remaining: [{"id": "primary", "label": "Weekly", "remaining": remaining, "reset_at": None, "period": 604800}]
            # Codex is checked every cycle; Claude only in the first one (a slower cadence).
            for offset in (0, 30, 60):
                for account in ("a", "b"):
                    store.save(account, "codex", {"observed_at": base + offset, "windows": window(90 - offset / 30)})
            store.save("c", "claude", {"observed_at": base, "windows": window(40)})
            rows = [r for r in store.history(24) if r["ts"] < base + 120]
            self.assertEqual(sorted((r["account"], r["ts"]) for r in rows),
                             [("a", base + 60), ("b", base + 60), ("c", base)])
            # Long ranges keep the slower provider too.
            self.assertIn("c", {r["account"] for r in store.history(24 * 14)})

    def test_nicknames_survive_a_new_hub(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "history.sqlite"
            Store(path).set_nickname("a.json", "Main")
            hub = Hub(Store(path))
            hub.files = [{"auth_index": "1", "name": "a.json", "provider": "codex"}, {"auth_index": "2", "name": "b.json", "provider": "codex"}]
            with patch.object(dashboard_server, "SILO_REGISTRY", Path(folder) / "none.json"):
                self.assertEqual([a["nickname"] for a in hub.snapshot(24)["accounts"]], ["Main", ""])

    def test_pooled_total_sums_accounts_and_never_dips_on_a_missing_sample(self):
        row = lambda ts, account, remaining, metric="m": {"ts": ts, "account": account, "metric": metric, "remaining": remaining}
        rows = [row(0, "a", 80), row(0, "b", 50), row(60, "a", 70),   # b has no sample at 60: carried forward
                row(2000, "a", 60), row(2100, "b", 40),             # b was missing for 2000s > gap: no point at 2000
                row(2150, "a", 55), row(0, "c", 10), row(0, "a", 1, "other")]
        series = dashboard_server.pool_series(rows, ["a", "b"], "m", 900)
        self.assertEqual([(p["ts"], p["value"]) for p in series], [(0, 130), (60, 120), (2100, 100), (2150, 95)])
        self.assertTrue(series[2].get("gap"))
        self.assertNotIn("gap", series[1])
        self.assertEqual(dashboard_server.pool_series(rows, ["a", "x"], "m", 900), [])

    def test_pooled_total_drops_a_retired_account_once_its_last_sample_is_stale(self):
        row = lambda ts, account, remaining: {"ts": ts, "account": account, "metric": "m", "remaining": remaining}
        rows = [row(0, "a", 80), row(0, "b", 50), row(500, "a", 70), row(500, "b", 40),  # b disabled after 500
                row(1000, "a", 60), row(2000, "a", 50), row(2500, "a", 45)]
        self.assertEqual([p["ts"] for p in dashboard_server.pool_series(rows, ["a", "b"], "m", 900)], [0, 500, 1000])
        series = dashboard_server.pool_series(rows, ["a", "b"], "m", 900, retired={"b"})
        self.assertEqual([(p["ts"], p["value"], bool(p.get("gap"))) for p in series],
                         [(0, 130, False), (500, 110, False), (1000, 100, False), (2000, 50, True), (2500, 45, False)])
        # a retired account with no samples in range is not a member at all
        self.assertEqual([p["ts"] for p in dashboard_server.pool_series(rows, ["a", "x"], "m", 900, retired={"x"})],
                         [0, 500, 1000, 2000, 2500])
        self.assertEqual(dashboard_server.pool_series(rows, ["a", "x"], "m", 900), [])

    def test_retired_members_that_resume_reporting_rejoin_without_blanking_the_gap(self):
        row = lambda ts, account, remaining: {"ts": ts, "account": account, "metric": "m", "remaining": remaining}
        rows = [row(t, "a", 50) for t in (0, 500, 1000, 2000, 3000, 4000)] + [row(t, "b", 30) for t in (0, 500, 3000, 4000)]
        series = dashboard_server.pool_series(rows, ["a", "b"], "m", 900, retired={"b"})
        self.assertEqual([(p["ts"], p["value"], bool(p.get("gap"))) for p in series],
                         [(0, 80, False), (500, 80, False), (1000, 80, False), (2000, 50, True),
                          (3000, 80, True), (4000, 80, False)])
        codex = [{"ts": t, "value": 150} for t in (0, 500, 1000, 2000, 3000, 4000)]
        claude = [{"ts": t, "value": 90} for t in (0, 500, 1000, 2000, 3000, 4000)]
        xai = [{"ts": t, "value": 60} for t in (0, 500, 3000, 4000)]
        stack = dashboard_server.pool_stack({"codex": codex, "claude": claude, "xai": xai}, 900, retired={"xai"})
        self.assertEqual([(p["ts"], p["value"]) for p in stack],
                         [(0, 300), (500, 300), (1000, 300), (2000, 240), (3000, 300), (4000, 300)])

    def test_all_accounts_stack_continues_past_a_retired_provider(self):
        codex = [{"ts": t, "value": 150} for t in (0, 500, 1000, 2000, 3000)]
        claude = [{"ts": t, "value": 90} for t in (0, 500, 1000, 2000, 3000)]
        xai = [{"ts": 0, "value": 60}, {"ts": 500, "value": 55}]   # every xai account disabled after 500
        series = {"codex": codex, "claude": claude, "xai": xai}
        self.assertEqual([p["ts"] for p in dashboard_server.pool_stack(series, 900)], [0, 500, 1000])
        stack = dashboard_server.pool_stack(series, 900, retired={"xai"})
        self.assertEqual([(p["ts"], p["value"], sorted(p["parts"]), bool(p.get("gap"))) for p in stack], [
            (0, 300, ["claude", "codex", "xai"], False), (500, 295, ["claude", "codex", "xai"], False),
            (1000, 295, ["claude", "codex", "xai"], False), (2000, 240, ["claude", "codex"], True),
            (3000, 240, ["claude", "codex"], False)])
        # a retired provider with nothing in range is left out instead of emptying the stack
        self.assertEqual(len(dashboard_server.pool_stack({**series, "xai": []}, 900, retired={"xai"})), 5)

    def test_snapshot_all_totals_skip_disabled_accounts_that_stopped_reporting(self):
        accounts = [
            {"id": "c", "provider": "codex", "weight": 1, "windows": [{"id": "rate_limit:7d", "period": 7 * 86400}]},
            {"id": "x", "provider": "xai", "weight": 1, "disabled": True, "windows": [{"id": "credits", "period": 7 * 86400}]},
            {"id": "s", "provider": "claude", "weight": 1, "silo": True, "disabled": True,
             "windows": [{"id": "seven_day", "period": 7 * 86400}]}]
        history = ([{"ts": t, "account": "c", "metric": "rate_limit:7d", "remaining": 80} for t in (0, 600, 3000, 3600)]
                   + [{"ts": t, "account": "s", "metric": "seven_day", "remaining": 70} for t in (0, 600, 3000, 3600)]
                   + [{"ts": t, "account": "x", "metric": "credits", "remaining": 50} for t in (0, 600)])
        points = dashboard_server.Hub.all_totals(accounts, history, 900)["7d"]["points"]
        self.assertEqual([(p["ts"], sorted(p["parts"])) for p in points][-2:],
                         [(3000, ["claude", "codex"]), (3600, ["claude", "codex"])])
        self.assertEqual(dashboard_server.Hub.totals(accounts, history, 300)["xai"]["credits"][-1]["ts"], 600)

    def test_all_totals_hide_disabled_accounts_and_backfill_late_joiners_without_steps(self):
        accounts = [
            {"id": "c", "provider": "codex", "weight": 1, "windows": [{"id": "rate_limit:7d", "period": 7 * 86400}]},
            {"id": "c2", "provider": "codex", "weight": 1, "windows": [{"id": "rate_limit:7d", "period": 7 * 86400}]},
            {"id": "d", "provider": "devin", "weight": 1, "windows": [{"id": "weekly", "period": 7 * 86400}]},
            {"id": "x", "provider": "xai", "weight": 1, "disabled": True, "windows": [{"id": "credits", "period": 7 * 86400}]}]
        history = ([{"ts": t, "account": "c", "metric": "rate_limit:7d", "remaining": 80} for t in (0, 600, 1200, 1800)]
                   + [{"ts": t, "account": "c2", "metric": "rate_limit:7d", "remaining": 40} for t in (1200, 1800)]
                   + [{"ts": t, "account": "d", "metric": "weekly", "remaining": 50} for t in (600, 1800)]
                   + [{"ts": t, "account": "x", "metric": "credits", "remaining": 90} for t in (0, 600, 1200, 1800)])
        totals = dashboard_server.Hub.all_totals(accounts, history, 900)["7d"]
        self.assertNotIn("xai", totals["metrics"])
        # The stack starts once a second provider (devin) reports; c2 joins later but counts at its
        # first reading from the start, so nothing steps.
        self.assertEqual([(p["ts"], p["parts_pct"], p["weighted"], bool(p.get("gap"))) for p in totals["points"]],
                         [(t, {"codex": 60.0, "devin": 50.0}, 55.0, False) for t in (600, 1200, 1800)])
        # a stretch with no readings at all still breaks the line
        late = history + [{"ts": 5000, "account": "c", "metric": "rate_limit:7d", "remaining": 70}]
        self.assertTrue(dashboard_server.Hub.all_totals(accounts, late, 900)["7d"]["points"][-1]["gap"])
        # a provider whose readings pause carries its last value instead of dropping its band
        quiet = [r for r in history if r["account"] != "d"] + [{"ts": 600, "account": "d", "metric": "weekly", "remaining": 50}]
        self.assertEqual({tuple(sorted(p["parts"])) for p in dashboard_server.Hub.all_totals(accounts, quiet, 900)["7d"]["points"]},
                         {("codex", "devin")})

    def test_snapshot_all_totals_5h_uses_the_shortest_window_of_providers_without_one(self):
        accounts = [
            {"id": "c", "provider": "codex", "weight": 1, "windows": [{"id": "rate_limit:5h", "period": 5 * 3600},
                                                                       {"id": "rate_limit:7d", "period": 7 * 86400}]},
            {"id": "d", "provider": "devin", "weight": 1, "windows": [{"id": "daily", "period": 86400},
                                                                       {"id": "weekly", "period": 7 * 86400}]},
            {"id": "x", "provider": "xai", "weight": 1, "windows": [{"id": "product:grokbot", "period": 86400},
                                                                     {"id": "credits", "period": 7 * 86400}]}]
        history = [{"ts": t, "account": a, "metric": m, "remaining": 50} for t in (0, 600)
                   for a, m in (("c", "rate_limit:5h"), ("c", "rate_limit:7d"), ("d", "daily"), ("d", "weekly"),
                                ("x", "credits"), ("x", "product:grokbot"))]
        totals = dashboard_server.Hub.all_totals(accounts, history, 900)
        self.assertEqual(totals["5h"]["metrics"], {"codex": "rate_limit:5h", "devin": "daily", "xai": "credits"})
        self.assertEqual(totals["7d"]["metrics"], {"codex": "rate_limit:7d", "devin": "weekly", "xai": "credits"})
        self.assertEqual(sorted(totals["5h"]["points"][-1]["parts"]), ["codex", "devin", "xai"])

    def test_all_accounts_stack_pools_providers_and_breaks_on_a_missing_provider(self):
        codex = [{"ts": 0, "value": 180}, {"ts": 300, "value": 170}, {"ts": 3000, "value": 150}]
        claude = [{"ts": 100, "value": 90}, {"ts": 400, "value": 80}]       # nothing from claude after 400
        stack = dashboard_server.pool_stack({"codex": codex, "claude": claude}, 900)
        self.assertEqual([(p["ts"], p["value"]) for p in stack], [(100, 270), (300, 260), (400, 250)])
        self.assertEqual(stack[0]["parts"], {"claude": 90, "codex": 180})
        # claude is stale (3000 - 400 > gap): no fake dip at 3000, the next point breaks the line
        stack = dashboard_server.pool_stack({"codex": codex, "claude": claude + [{"ts": 3100, "value": 70}]}, 900)
        self.assertEqual([(p["ts"], p["value"]) for p in stack][-1], (3100, 220))
        self.assertTrue(stack[-1].get("gap"))
        self.assertEqual(dashboard_server.pool_stack({"codex": codex, "claude": []}, 900), [])

    def test_pool_stack_keeps_prior_history_when_a_new_provider_joins_later(self):
        # Single-provider pre-history (-5000) is omitted on a multi-provider stack, while multi-provider
        # history stays intact when a third provider joins later.
        codex = [{"ts": -5000, "value": 180}, {"ts": 0, "value": 150}, {"ts": 300, "value": 140}, {"ts": 5000, "value": 130}, {"ts": 5300, "value": 125}]
        claude = [{"ts": 100, "value": 90}, {"ts": 400, "value": 85}, {"ts": 5050, "value": 80}, {"ts": 5350, "value": 75}]
        devin = [{"ts": 5100, "value": 98}, {"ts": 5400, "value": 96}]
        stack = dashboard_server.pool_stack({"codex": codex, "claude": claude, "devin": devin}, 900)
        self.assertEqual([(p["ts"], p["value"], sorted(p["parts"]), bool(p.get("gap"))) for p in stack], [
            (100, 240, ["claude", "codex"], False),
            (300, 230, ["claude", "codex"], False),
            (400, 225, ["claude", "codex"], False),
            (5050, 210, ["claude", "codex"], True),
            (5100, 308, ["claude", "codex", "devin"], True),
            (5300, 303, ["claude", "codex", "devin"], False),
            (5350, 298, ["claude", "codex", "devin"], False),
            (5400, 296, ["claude", "codex", "devin"], False),
        ])

    def test_snapshot_all_total_uses_each_providers_window_of_that_length(self):
        with tempfile.TemporaryDirectory() as folder:
            hub = Hub(Store(Path(folder) / "history.sqlite"))
            now = time.time()
            win = lambda i, r, period: [{"id": i, "label": i, "remaining": r, "reset_at": None, "period": period}]
            spec = {"1": ("claude", "five_hour", 60, 18000), "2": ("codex", "rate_limit:5h", 100, 18000)}
            hub.files = [{"auth_index": k, "name": k + ".json", "provider": v[0]} for k, v in spec.items()]
            for k, (prov, metric, r, period) in spec.items():
                data = {"observed_at": now - 60, "windows": win(metric, r, period)}
                hub.store.save(k, prov, data)
                hub.quotas[k] = data
            five = hub.snapshot(24)["totals"]["all"]["5h"]
            self.assertEqual(five["metrics"], {"claude": "five_hour", "codex": "rate_limit:5h"})
            self.assertEqual([p["value"] for p in five["points"]], [160])
            self.assertEqual(hub.snapshot(24)["totals"]["all"]["7d"]["points"], [])

    def test_claude_profile_keeps_only_parsed_subscription_fields(self):
        profile = {"account": {"email": "a@b.c", "created_at": "2025-03-07T02:57:26Z", "access_token": "SECRET"},
                   "organization": {"name": "Org", "organization_type": "claude_pro", "billing_type": "stripe_subscription",
                                    "rate_limit_tier": "default_claude_ai", "seat_tier": None, "subscription_status": "active",
                                    "subscription_created_at": "2026-04-30T23:39:47Z", "has_extra_usage_enabled": False,
                                    "claude_code_trial_ends_at": None}}
        got = dashboard_server.parse_claude_profile(profile)
        self.assertEqual((got["billing"], got["org_name"], got["subscription_status"], got["extra_usage"]),
                         ("Web (Stripe)", "Org", "active", False))
        self.assertEqual(got["subscription_started"], 1777592387.0)
        self.assertIsNone(got["seat"])
        self.assertIsNone(got["trial_ends"])
        self.assertNotIn("SECRET", json.dumps(got))
        self.assertEqual(dashboard_server.parse_claude_profile({"organization": {"billing_type": "apple_subscription"}})["billing"], "Apple (App Store)")
        self.assertIsNone(dashboard_server.parse_claude_profile({}))

    def test_codex_claims_parse_dates_and_tolerate_missing_fields(self):
        got = quota_readers.parse_codex_claims({"plan_type": "plus", "chatgpt_account_id": "x",
                                                   "chatgpt_subscription_active_start": "2026-10-27T06:17:39+00:00",
                                                   "chatgpt_subscription_active_until": "2026-11-27T06:17:39+00:00"})
        self.assertEqual(got["plan_type"], "plus")
        self.assertEqual(got["subscription_until"] - got["subscription_started"], 31 * 86400)
        self.assertIsNone(got["subscription_checked"])
        empty = quota_readers.parse_codex_claims(None)
        self.assertEqual(set(empty.values()), {None})

    def test_account_detail_for_snapshot_has_no_secrets(self):
        raw = {"auth_index": "1", "name": "c.json", "provider": "codex", "created_at": "2026-11-20T11:52:01-06:00",
               "access_token": "SECRET", "refresh_token": "SECRET2",
               "id_token": {"plan_type": "plus", "chatgpt_subscription_active_until": "2026-11-27T06:17:39+00:00", "chatgpt_account_id": "ACCT"}}
        detail = dashboard_server.account_detail(raw)
        self.assertEqual(detail["file"], "c.json")
        self.assertEqual(detail["provider_fields"]["plan_type"], "plus")
        self.assertNotIn("SECRET", json.dumps(detail))
        self.assertNotIn("ACCT", json.dumps(detail))
        claude = dashboard_server.account_detail({"name": "x.json", "provider": "claude"}, {"profile": {"billing": "Apple (App Store)"}})
        self.assertEqual(claude["provider_fields"], {"billing": "Apple (App Store)"})

    def test_snapshot_totals_pool_each_provider_window(self):
        with tempfile.TemporaryDirectory() as folder:
            hub = Hub(Store(Path(folder) / "history.sqlite"))
            now = time.time()
            win = lambda r: [{"id": "five_hour", "label": "5-hour", "remaining": r, "reset_at": None, "period": 18000}]
            hub.files = [{"auth_index": "1", "name": "a.json", "provider": "claude"}, {"auth_index": "2", "name": "b.json", "provider": "claude"}]
            for idx, r in (("1", 60), ("2", 25)):
                hub.store.save(idx, "claude", {"observed_at": now - 60, "windows": win(r)})
                hub.quotas[idx] = {"observed_at": now - 60, "windows": win(r)}
            totals = hub.snapshot(24)["totals"]
            self.assertEqual([p["value"] for p in totals["claude"]["five_hour"]], [85])

    def test_history_survives_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "history.sqlite"
            data = {"observed_at": time.time(), "windows": [{"id": "weekly", "remaining": 62, "reset_at": None, "period": 604800}]}
            Store(path).save("a", "codex", data)
            restarted = Hub(Store(path))
            self.assertEqual(restarted.quotas["a"]["windows"][0]["remaining"], 62)
            self.assertEqual(len(restarted.store.history()), 1)


class SnapshotCacheTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.hub = Hub(Store(Path(self.folder.name) / "history.sqlite"))
        self.hub.files = [{"auth_index": "1", "name": "a.json", "provider": "claude"}]
        registry = patch.object(dashboard_server, "SILO_REGISTRY", Path(self.folder.name) / "none.json")
        registry.start()
        self.addCleanup(registry.stop)

    def save(self, remaining, at):
        data = {"observed_at": at, "windows": [{"id": "five_hour", "label": "5h", "remaining": remaining,
                                                "reset_at": None, "period": 18000}]}
        self.hub.store.save("1", "claude", data)
        self.hub.quotas["1"] = data

    def test_history_arrives_grouped_by_series_with_the_server_gap(self):
        now = time.time()
        self.save(70, now - 600)
        self.save(60, now - 60)
        snap = self.hub.snapshot(24)
        self.assertEqual(snap["history"], [{"account": "1", "metric": "five_hour", "ts": [now - 600, now - 60],
                                            "remaining": [70, 60], "reset_at": [None, None]}])
        self.assertEqual((snap["history_bucket"], snap["history_gap"]), (120, 900))
        self.assertEqual(self.hub.snapshot(24 * 7)["history_gap"], dashboard_server.history_gap(840))

    def test_cached_history_is_reused_then_rebuilt_on_new_samples_and_account_changes(self):
        now = time.time()
        self.save(70, now - 600)
        first = self.hub.snapshot(24)
        with patch.object(self.hub.store, "history", side_effect=AssertionError("cache missed")):
            self.assertEqual(self.hub.snapshot(24)["totals"], first["totals"])
            self.save(65, now - 300)  # a new sample alone waits for HISTORY_REBUILD_INTERVAL
            self.assertEqual(len(self.hub.snapshot(24)["history"][0]["ts"]), 1)
        with patch.object(dashboard_server, "HISTORY_REBUILD_INTERVAL", 0):
            self.assertEqual(self.hub.snapshot(24)["history"][0]["remaining"], [70, 65])
        # A changed weight changes the pooled units at once, without waiting for the rebuild interval.
        self.hub.store.set_weight_override("a.json", 5)
        self.assertEqual(self.hub.snapshot(24)["totals"]["claude"]["five_hour"][-1]["units"], 3.25)
        # Each range is cached on its own, oldest dropped first.
        for hours in (1, 2, 3, 4, 5):
            self.hub.snapshot(hours)
        self.assertEqual(list(self.hub.history_cache), [2, 3, 4, 5])

    def test_spliced_gzip_snapshot_matches_the_plain_encoding(self):
        now = time.time()
        for i in range(50):
            self.save(100 - i, now - 7500 + i * 150)  # one sample per 120s history bucket
        with patch.object(dashboard_server.time, "time", return_value=now):
            plain = self.hub.snapshot_json(24)
            packed = self.hub.snapshot_json(24, gzipped=True)
            again = self.hub.snapshot_json(24, gzipped=True)  # reuses the cached compressed tail
        self.assertEqual(gzip.decompress(packed), plain)
        self.assertEqual(gzip.decompress(again), plain)
        snap = json.loads(plain)
        self.assertEqual(len(snap["history"][0]["ts"]), 50)
        self.assertIn("totals", snap)
        self.assertEqual(snap["accounts"][0]["id"], "1")

    def test_flat_history_for_pages_that_do_not_ask_for_series(self):
        now = time.time()
        self.save(70, now - 600)
        self.save(60, now - 60)
        with patch.object(dashboard_server.time, "time", return_value=now):
            grouped = json.loads(self.hub.snapshot_json(24))
            flat = json.loads(gzip.decompress(self.hub.snapshot_json(24, gzipped=True, series=False)))
        # The flat rows are the previous format exactly, as Store.history returns them.
        self.assertEqual(flat["history"], self.hub.store.history(24))
        self.assertEqual(flat["history"][0], {"ts": now - 600, "account": "1", "provider": "claude", "metric": "five_hour",
                                              "remaining": 70, "reset_at": None, "period": 18000})
        self.assertEqual({k: v for k, v in flat.items() if k != "history"},
                         {k: v for k, v in grouped.items() if k != "history"})

    def test_concurrent_polls_build_one_range_once(self):
        self.save(70, time.time() - 600)
        started, release, waiting, calls = threading.Event(), threading.Event(), threading.Event(), []
        real_history, real_lock = self.hub.store.history, threading.Lock()

        class BuildLock:  # the range's build lock, reporting when a second poll waits on it
            def __enter__(self):
                if real_lock.locked():
                    waiting.set()
                real_lock.acquire()

            def __exit__(self, *exc):
                real_lock.release()

        def slow(hours):
            calls.append(hours)
            started.set()
            release.wait(5)
            return real_history(hours)

        self.hub.history_builds[24] = BuildLock()
        with patch.object(self.hub.store, "history", side_effect=slow):
            first = threading.Thread(target=self.hub.snapshot, args=(24,))
            first.start()
            self.assertTrue(started.wait(5))
            second = threading.Thread(target=self.hub.snapshot, args=(24,))
            second.start()
            self.assertTrue(waiting.wait(5))
            release.set()
            first.join(5)
            second.join(5)
        self.assertEqual(calls, [24])  # the waiting poll reused the build instead of repeating it

    def test_a_build_from_older_inputs_never_replaces_newer_history(self):
        self.save(70, time.time() - 600)
        accounts, cal_map = [], {}
        newer = self.hub.build_history_view(24, accounts, cal_map, "sig", gen=5)
        older = self.hub.build_history_view(24, accounts, cal_map, "sig", gen=4)  # finished last
        self.assertIs(self.hub.history_cache[24], newer)
        self.assertIsNot(older, newer)

    def test_a_cache_hit_counts_as_newer_inputs(self):
        self.save(70, time.time() - 600)
        cached = self.hub.history_view(24, [], {}, gen=1)
        self.assertIs(self.hub.history_view(24, [], {}, gen=3), cached)  # reused by newer inputs
        self.hub.build_history_view(24, [], {}, "other", gen=2)  # a build started before that poll
        self.assertIs(self.hub.history_cache[24], cached)

    def test_flat_rows_rebuild_in_their_original_order(self):
        rows = [{"ts": t, "account": a, "provider": p, "metric": m, "remaining": r, "reset_at": None, "period": d}
                for t, a, p, m, r, d in [(1, "b", "codex", "weekly", 50, 604800), (1, "a", "claude", "five_hour", 40, 18000),
                                         (2, "a", "claude", "five_hour", 30, 18000), (2, "b", "codex", "weekly", 45, 604800),
                                         (3, "b", "codex2", "weekly", 44, 86400)]]
        series, legacy = history_store.history_series(rows)
        self.assertEqual(history_store.history_rows(series, legacy), rows)

    def test_store_prunes_old_samples_at_most_hourly(self):
        store = self.hub.store
        old = time.time() - history_store.HISTORY_RETENTION - 60
        win = [{"id": "w", "remaining": 1, "reset_at": None, "period": 18000}]
        def query(sql):
            with contextlib.closing(sqlite3.connect(store.path)) as db:
                return db.execute(sql).fetchone()[0]
        count = lambda: query("SELECT COUNT(*) FROM samples")
        store.save("x", "claude", {"observed_at": old, "windows": win})  # first save prunes, then keeps going
        self.assertEqual(count(), 0)
        store.save("x", "claude", {"observed_at": old - 1, "windows": win})
        self.assertEqual(count(), 1)
        store.pruned_at -= history_store.PRUNE_INTERVAL
        store.save("x", "claude", {"observed_at": time.time(), "windows": win})
        self.assertEqual(count(), 1)
        self.assertEqual(query("PRAGMA journal_mode"), "wal")

    def test_registry_and_key_reads_follow_file_changes(self):
        path = Path(self.folder.name) / "registry.json"
        entry = {"seat": "s1", "provider": "codex", "node": "n", "silo_cpa_base": "http://127.0.0.1:1",
                 "cpakey": "k", "hub_auth_name": "a1"}
        path.write_text(json.dumps([entry]))
        old = time.time() - 60
        os.utime(path, (old, old))
        with patch.object(dashboard_server, "SILO_REGISTRY", path):
            first = dashboard_server.load_registry()
            first[0]["seat"] = "mutated"  # callers get copies; the cache stays clean
            with patch.object(Path, "read_text", side_effect=AssertionError("cache missed")):
                self.assertEqual(dashboard_server.load_registry()[0]["seat"], "s1")
            path.write_text(json.dumps([dict(entry, seat="s2-renamed")]))
            os.utime(path, (old + 10, old + 10))
            self.assertEqual(dashboard_server.load_registry()[0]["seat"], "s2-renamed")
            path.write_text(json.dumps([dict(entry, seat="s3-renamed")]))  # just written: never trusted from cache
            self.assertEqual(dashboard_server.load_registry()[0]["seat"], "s3-renamed")
        creds = Path(self.folder.name) / "credentials.json"
        with patch.object(dashboard_server, "CREDENTIALS", creds):
            creds.write_text(json.dumps({"management_key": "one"}))
            self.assertEqual(Hub.management_key(), "one")
            creds.write_text(json.dumps({"management_key": "rotated"}))
            self.assertEqual(Hub.management_key(), "rotated")

    def test_pool_series_matches_a_from_scratch_active_set(self):
        # Accounts joining at different times, one going stale: the incremental active set must give
        # the same points as recomputing it per row.
        rows = []
        for ts in range(0, 20000, 300):
            rows.append({"ts": ts, "account": "a", "metric": "m", "remaining": 50 + ts % 7})
            if ts >= 3000 and not 9000 <= ts < 11000:
                rows.append({"ts": ts + 30, "account": "b", "metric": "m", "remaining": 40})
            if ts >= 12000:
                rows.append({"ts": ts, "account": "c", "metric": "m", "remaining": 10})

        def reference(rows, ids, gap):
            rows = sorted(rows, key=lambda r: r["ts"])
            first = {}
            for r in rows:
                first.setdefault(r["account"], r["ts"])
            min_ts, latest, out, broken, prev = min(first.values()), {}, [], False, None
            for i, r in enumerate(rows):
                latest[r["account"]] = r
                if i + 1 < len(rows) and rows[i + 1]["ts"] == r["ts"]:
                    continue
                active = tuple(sorted(a for a in ids if first[a] <= max(r["ts"], min_ts + gap)))
                if all(r["ts"] - latest[a]["ts"] <= gap for a in active):
                    p = {"ts": r["ts"], "value": sum(latest[a]["remaining"] for a in active)}
                    if broken or (prev is not None and active != prev):
                        p["gap"] = True
                    out.append(p)
                    broken, prev = False, active
                elif out:
                    broken = True
            return out

        got = dashboard_server.pool_series(rows, ["a", "b", "c"], "m", 900)
        self.assertEqual(got, reference(rows, ["a", "b", "c"], 900))
        self.assertTrue(any(p.get("gap") for p in got))


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.TemporaryDirectory()
        cls.hub = Hub(Store(Path(cls.folder.name) / "test.sqlite"))
        cls.hub.management_key = lambda: "test-only-key"
        cls.hub.files = [{"auth_index": "a", "name": "a.json", "provider": "codex", "disabled": False}]
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.server.hub = cls.hub
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.folder.cleanup()

    def request(self, path, body=None, cookie=None, origin=None, host="localhost:8318", extra=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port)
        headers = {"Host": host, "X-Dashboard-Request": "1", "Content-Type": "application/json", **(extra or {})}
        if cookie:
            headers["Cookie"] = cookie
        if origin:
            headers["Origin"] = origin
        conn.request("GET" if body is None else "POST", "/dashboard/api/" + path,
                     body=json.dumps(body) if body is not None else None, headers=headers)
        res = conn.getresponse()
        result = res.status, json.loads(res.read()), res.getheader("Set-Cookie")
        conn.close()
        return result

    def login(self):
        status, data, cookie = self.request("login", {"key": "test-only-key"})
        self.assertEqual(status, 200)
        return cookie.split(";")[0]

    def raw_get(self, path, headers):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port)
        conn.request("GET", path, headers={"Host": "localhost:8318", **headers})
        res = conn.getresponse()
        result = res.status, dict(res.getheaders()), res.read()
        conn.close()
        return result

    def test_static_files_revalidate_by_etag_per_encoding(self):
        status, headers, body = self.raw_get("/dashboard/", {"Accept-Encoding": "gzip"})
        self.assertEqual((status, headers["Content-Encoding"], headers["Cache-Control"]), (200, "gzip", "no-cache"))
        self.assertEqual(gzip.decompress(body), (dashboard_server.ROOT / "index.html").read_bytes())
        self.assertEqual(body[4:8], b"\x00\x00\x00\x00")  # no timestamp: equal files, equal bytes under one ETag
        tag = headers["ETag"]
        status, headers, body = self.raw_get("/dashboard/accounts", {"Accept-Encoding": "gzip", "If-None-Match": tag})
        self.assertEqual((status, body, headers["ETag"]), (304, b"", tag))
        for match in ('"other", W/' + tag, "*"):  # weak comparison, and any current file
            self.assertEqual(self.raw_get("/dashboard/", {"Accept-Encoding": "gzip", "If-None-Match": match})[0], 304)
        status, headers, body = self.raw_get("/dashboard/", {"If-None-Match": tag})  # identity is another representation
        self.assertEqual(status, 200)
        self.assertNotIn("Content-Encoding", headers)
        self.assertNotEqual(headers["ETag"], tag)
        status, headers, body = self.raw_get("/dashboard/assets/geist-sans.woff2", {"Accept-Encoding": "gzip"})
        self.assertEqual((status, headers.get("Content-Encoding")), (200, None))  # woff2 is compressed already

    def test_ios_and_favicon_icons_are_served_without_auth(self):
        html = (dashboard_server.ROOT / "index.html").read_text(encoding="utf-8")
        head = html.split("<style>", 1)[0]
        self.assertIn('<link rel="apple-touch-icon" sizes="180x180" href="/dashboard/assets/apple-touch-icon.png" />', head)
        self.assertIn('<meta property="og:image" content="/dashboard/assets/apple-touch-icon.png" />', head)
        self.assertNotIn("data:image/svg+xml", head)

        expected = {
            "/dashboard/assets/apple-touch-icon.png": ("apple-touch-icon.png", "image/png", None),
            "/dashboard/assets/icon-32.png": ("icon-32.png", "image/png", None),
            "/dashboard/assets/favicon.ico": ("favicon.ico", "image/x-icon", None),
            "/dashboard/assets/icon.svg": ("icon.svg", "image/svg+xml", None),
            "/apple-touch-icon.png": ("apple-touch-icon.png", "image/png", None),
            "/apple-touch-icon-precomposed.png": ("apple-touch-icon.png", "image/png", None),
            "/apple-touch-icon-180x180.png": ("apple-touch-icon.png", "image/png", None),
            "/apple-touch-icon-180x180-precomposed.png": ("apple-touch-icon.png", "image/png", None),
            "/favicon.ico": ("favicon.ico", "image/x-icon", None),
        }
        for route, (filename, content_type, encoding) in expected.items():
            status, headers, body = self.raw_get(route, {"Accept-Encoding": "gzip"})
            self.assertEqual((status, headers["Content-Type"], headers.get("Content-Encoding")),
                             (200, content_type, encoding), route)
            raw = (dashboard_server.ROOT / "assets" / filename).read_bytes()
            self.assertEqual(body, raw, route)

        # Apple touch icon must be an opaque 180x180 24-bit RGB PNG (color type 2) so iOS masks it cleanly.
        apple_png = (dashboard_server.ROOT / "assets" / "apple-touch-icon.png").read_bytes()
        self.assertEqual(apple_png[:8], b"\x89PNG\r\n\x1a\n")
        width, height, bit_depth, color_type = dashboard_server.struct.unpack(">IIBB", apple_png[16:26])
        self.assertEqual((width, height, bit_depth, color_type), (180, 180, 8, 2))

        icon32_png = (dashboard_server.ROOT / "assets" / "icon-32.png").read_bytes()
        self.assertEqual(icon32_png[:8], b"\x89PNG\r\n\x1a\n")
        self.assertEqual(dashboard_server.struct.unpack(">II", icon32_png[16:24]), (32, 32))

        ico = (dashboard_server.ROOT / "assets" / "favicon.ico").read_bytes()
        self.assertEqual(dashboard_server.struct.unpack("<HHH", ico[:6]), (0, 1, 2))

        # HEAD requests succeed for iOS metadata fetchers without sending a response body.
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        conn.request("HEAD", "/apple-touch-icon.png", headers={"Host": f"127.0.0.1:{dashboard_server.PORT}"})
        res = conn.getresponse()
        body = res.read()
        conn.close()
        self.assertEqual((res.status, res.getheader("Content-Type"), int(res.getheader("Content-Length")), body),
                         (200, "image/png", len(apple_png), b""))

    def test_server_loads_its_modules_in_isolated_mode(self):
        import subprocess
        # The Windows hub runs `python -I server.py`, which leaves the script's folder off sys.path.
        load = ("import importlib.util as u; s = u.spec_from_file_location('server', %r); "
                "s.loader.exec_module(u.module_from_spec(s))" % str(dashboard_server.ROOT / "server.py"))
        with tempfile.TemporaryDirectory() as tmp:
            done = subprocess.run([sys.executable, "-I", "-c", load], cwd=tmp, capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_deploy_installs_every_module_the_server_imports(self):
        import ast
        import deploy
        root, seen, todo = dashboard_server.ROOT, set(), ["server"]
        while todo:  # follow imports between the dashboard's own modules
            name = todo.pop()
            if name in seen or not (root / (name + ".py")).exists():
                continue
            seen.add(name)
            for node in ast.walk(ast.parse((root / (name + ".py")).read_text(encoding="utf-8"))):
                if isinstance(node, ast.ImportFrom) and node.module:
                    todo.append(node.module)
                elif isinstance(node, ast.Import):
                    todo.extend(a.name for a in node.names)
        self.assertEqual({n + ".py" for n in seen}, set(deploy.BACKEND))

    def test_page_scripts_are_all_served_in_order(self):
        html = (dashboard_server.ROOT / "index.html").read_text(encoding="utf-8")
        listed = re.findall(r'<script src="/dashboard/assets/(app-[a-z-]+\.js)"></script>', html)
        self.assertEqual(listed, dashboard_server.APP_SCRIPTS)
        self.assertNotIn("<script>", html)  # no inline code left behind
        for name in listed:
            status, headers, body = self.raw_get("/dashboard/assets/" + name, {})
            self.assertEqual((status, headers["Content-Type"]), (200, "text/javascript; charset=utf-8"))
            self.assertEqual(body, (dashboard_server.ROOT / "assets" / name).read_bytes())
        self.assertNotEqual(self.raw_get("/dashboard/assets/app-missing.js", {})[0], 200)  # only listed files are served

    def test_release_copies_of_page_scripts_are_served_immutable(self):
        name = "app-core." + "a" * 20 + ".js"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "assets").mkdir()
            (root / "assets" / name).write_bytes(b"// pinned release")
            renamed = "app-retired." + "b" * 20 + ".js"  # a script the new release no longer has
            (root / "assets" / renamed).write_bytes(b"// previous release")
            (root / "assets" / "app-core.short.js").write_bytes(b"// not a release copy")
            with patch.object(dashboard_server, "ROOT", root):
                status, headers, body = self.raw_get("/dashboard/assets/" + name, {})
                self.assertEqual((status, body, headers["Cache-Control"]), (200, b"// pinned release", "max-age=31536000, immutable"))
                self.assertEqual(self.raw_get("/dashboard/assets/" + renamed, {})[:3:2], (200, b"// previous release"))
                self.assertNotEqual(self.raw_get("/dashboard/assets/app-core." + "c" * 20 + ".js", {})[0], 200)
                self.assertNotEqual(self.raw_get("/dashboard/assets/app-core.short.js", {})[0], 200)
                self.assertNotEqual(self.raw_get("/dashboard/assets/..%2F" + name, {})[0], 200)
                (root / "assets" / renamed).unlink()  # a later deploy prunes it; its cached bytes go too
                newer = "app-core." + "d" * 20 + ".js"
                (root / "assets" / newer).write_bytes(b"// next release")
                self.assertEqual(self.raw_get("/dashboard/assets/" + newer, {})[2], b"// next release")
                self.assertNotIn(root / "assets" / renamed, dashboard_server._static)

    def test_deploy_pins_page_scripts_to_release_copies(self):
        import deploy
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "dashboard"
            (target / "assets").mkdir(parents=True)
            stale, previous = "app-core." + "1" * 20 + ".js", "app-core." + "2" * 20 + ".js"
            for old in (stale, previous):
                (target / "assets" / old).write_bytes(b"old")
            (target / "index.html").write_text('<script src="/dashboard/assets/%s"></script>' % previous, encoding="utf-8")
            with patch.object(deploy, "TARGET", target):
                html = deploy.pin_scripts().decode("utf-8")
            pinned = re.findall(r'<script src="/dashboard/assets/([a-z-]+)\.([0-9a-f]{20})\.js"></script>', html)
            self.assertEqual([n for n, _ in pinned], deploy.SCRIPT_TAG.findall(
                (dashboard_server.ROOT / "index.html").read_text(encoding="utf-8")))
            for name, digest in pinned:
                self.assertEqual((target / "assets" / f"{name}.{digest}.js").read_bytes(),
                                 (dashboard_server.ROOT / "assets" / (name + ".js")).read_bytes())
            self.assertTrue((target / "assets" / previous).exists())  # the page being replaced still loads it
            self.assertFalse((target / "assets" / stale).exists())
            self.assertEqual(re.sub(r"\.[0-9a-f]{20}\.js", ".js", html),
                             (dashboard_server.ROOT / "index.html").read_text(encoding="utf-8"))

    def test_snapshot_is_gzipped_when_accepted(self):
        cookie = self.login()
        status, headers, body = self.raw_get("/dashboard/api/snapshot?hours=24&history=series",
                                             {"Cookie": cookie, "Accept-Encoding": "gzip"})
        self.assertEqual((status, headers["Content-Encoding"]), (200, "gzip"))
        snap = json.loads(gzip.decompress(body))
        self.assertEqual((snap["history_bucket"], snap["history_gap"]), (120, 900))
        status, headers, body = self.raw_get("/dashboard/api/snapshot?hours=24", {"Cookie": cookie})
        self.assertNotIn("Content-Encoding", headers)
        self.assertEqual(json.loads(body)["accounts"][0]["id"], "a")

    def test_subscription_terms_round_trip_and_shared_seat_guard(self):
        cookie = self.login()
        terms = {"kind": "trial-renews", "cycle": "yearly", "cents": 24000, "date": "2028-02-29"}
        def save(idx, **changes):
            return self.request("account/subscription", {**terms, "id": idx, **changes}, cookie)
        with patch.object(self.hub, "files", [{"auth_index": "sub1", "name": "billing.json", "provider": "codex",
                                               "id_token": {"chatgpt_account_id": "sample"}}]):
            self.hub.store.set_subscription("billing.json", terms)
            self.assertEqual(self.request("snapshot", cookie=cookie)[1]["accounts"][0]["subscription"], terms)
            self.assertEqual(save("sub1", kind="clear")[0], 200)
            self.assertIsNone(self.request("snapshot", cookie=cookie)[1]["accounts"][0]["subscription"])
            self.assertNotIn("billing.json", self.hub.store.subscriptions())
            # A direct clear before the first upgraded snapshot must remove legacy terms too.
            self.hub.store.set_subscription("billing.json", terms)
            self.hub.store.set_subscription("offline.json", terms)
            self.assertEqual(save("sub1", kind="clear")[0], 200)
            self.assertIsNone(self.request("snapshot", cookie=cookie)[1]["accounts"][0]["subscription"])
            self.hub.files.append(dict(self.hub.files[0], auth_index="offline", name="offline.json"))
            restored = self.request("snapshot", cookie=cookie)[1]["accounts"]
            self.assertEqual({a["id"]: a["subscription"] for a in restored if a["id"] in ("sub1", "offline")},
                             {"sub1": None, "offline": None})
            self.assertNotIn("offline.json", self.hub.store.subscriptions())
            self.assertEqual(save("sub1")[:2], (200, terms))
            self.hub.files[0]["auth_index"] = "sub2"
            self.hub.files[0]["name"] = "billing-pro.json"
            self.assertEqual(self.request("snapshot", cookie=cookie)[1]["accounts"][0]["subscription"], terms)
            self.assertEqual(save("sub2", date="2027-02-29")[0], 400)
            self.assertEqual(save("sub2", cents=True)[0], 400)
            self.assertEqual(save("sub2", kind="trial")[1], {"kind": "trial", "date": terms["date"]})
            self.assertEqual(save("sub2", kind="estimate")[0], 400)
            self.assertEqual(save("missing")[0], 404)
        with patch.object(dashboard_server, "silo_entry", return_value={"hub_auth_name": "shared"}):
            self.assertEqual(save("silo:shared")[0], 400)
            self.assertEqual(save("silo:shared", kind="estimate")[1],
                             {"kind": "estimate", "cycle": "yearly", "cents": 24000})

    def test_auth_and_csrf_boundaries(self):
        self.assertEqual(self.request("snapshot")[0], 401)
        self.assertEqual(self.request("login", {"key": "wrong"})[0], 401)
        self.assertEqual(self.request("login", {"key": "test-only-key"}, origin="https://evil.example")[0], 403)
        self.assertEqual(self.request("session", host="evil.example")[0], 403)
        cookie = self.login()
        self.assertEqual(self.request("snapshot", cookie=cookie)[0], 200)
        self.assertEqual(self.request("logout", {}, cookie=cookie)[0], 200)
        self.assertEqual(self.request("snapshot", cookie=cookie)[0], 401)

    def test_listed_tailnet_login_needs_no_key_but_cannot_be_forged_publicly(self):
        me = {"Tailscale-User-Login": "me@github"}
        with patch.object(dashboard_server, "TAILNET_USERS", {"me@github"}):
            self.assertEqual(self.request("session", extra=me)[1], {"authenticated": True, "tailnet": True})
            self.assertEqual(self.request("snapshot", extra=me)[0], 200)
            self.assertEqual(self.request("logout", {}, extra=me)[0], 200)
            # Anyone else, or no header, still needs the key.
            self.assertEqual(self.request("snapshot", extra={"Tailscale-User-Login": "other@github"})[0], 401)
            self.assertEqual(self.request("session")[1], {"authenticated": False, "tailnet": False})
            # A request relayed from the public internet can't vouch for itself.
            self.assertEqual(self.request("snapshot", extra={**me, "CF-Connecting-IP": "203.0.113.9"})[0], 401)
        # With no logins listed, the header means nothing.
        self.assertEqual(self.request("snapshot", extra=me)[0], 401)

    def test_panel_route_is_gone(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port)
        conn.request("GET", "/dashboard/panel", headers={"Host": "localhost:8318"})
        res = conn.getresponse()
        body = res.read().decode()
        conn.close()
        self.assertNotEqual(res.status, 200)
        self.assertNotIn("placeholder", body)

    def test_funnel_requests_are_refused(self):
        self.assertEqual(self.request("session", extra={"Tailscale-Funnel-Request": "?1"})[0], 403)

    def test_sessions_survive_a_restart_renew_and_end_on_key_rotation(self):
        cookie = self.login()
        token_hash = Handler.digest(cookie.split("=", 1)[1])
        self.assertNotIn(cookie.split("=", 1)[1], Path(self.folder.name, "test.sqlite").read_bytes().decode("latin-1"))
        # A restart builds a new hub; the stored session still signs in.
        restarted = Hub(Store(Path(self.folder.name) / "test.sqlite"))
        restarted.management_key = lambda: "test-only-key"
        with patch.object(self.server, "hub", restarted):
            status, _, renewed = self.request("snapshot", cookie=cookie)
        self.assertEqual(status, 200)
        self.assertIsNone(renewed, "A fresh session is not re-issued on every request")
        # An older session is renewed for another 400 days on use.
        self.hub.store.renew_session(token_hash, time.time() + 3600)
        status, _, renewed = self.request("snapshot", cookie=cookie)
        self.assertEqual(status, 200)
        self.assertIn(f"Max-Age={dashboard_server.SESSION_TTL}", renewed)
        self.assertGreater(self.hub.store.session(token_hash)[0], time.time() + dashboard_server.SESSION_TTL - 60)
        # Rotating the management key ends sessions issued under the old one.
        with patch.object(self.hub, "management_key", return_value="rotated-key"):
            self.assertEqual(self.request("snapshot", cookie=cookie)[0], 401)
        self.hub.store.renew_session(token_hash, time.time() - 1)
        self.assertEqual(self.request("snapshot", cookie=cookie)[0], 401)

    def test_each_page_path_serves_the_app(self):
        for path, expected in [("/dashboard/", 200), ("/dashboard/accounts", 200), ("/dashboard/keys", 200), ("/dashboard/tokens", 200), ("/dashboard/logs/", 200),
                               ("/dashboard/settings", 401)]:
            conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port)
            conn.request("GET", path, headers={"Host": "localhost:8318"})
            res = conn.getresponse()
            body = res.read()
            conn.close()
            self.assertEqual(res.status, expected, path)
            if expected == 200:
                self.assertIn("text/html", res.getheader("Content-Type"))
                self.assertIn(b"<html", body[:200])

    def test_public_cookie_is_secure_and_not_script_readable(self):
        with patch.object(dashboard_server, "PUBLIC_HOSTS", ["proxy.example.test"]):
            code, _, cookie = self.request("login", {"key": "test-only-key"}, host="proxy.example.test")
        self.assertEqual(code, 200)
        for flag in ["HttpOnly", "Secure", "SameSite=Strict", "Path=/dashboard", "Max-Age=34560000"]:
            self.assertIn(flag, cookie)

    def test_only_configured_public_hosts_are_served(self):
        with patch.object(dashboard_server, "PUBLIC_HOSTS", ["proxy.example.test", "box.tail.ts.net:8317"]):
            self.assertEqual(self.request("session", host="proxy.example.test")[0], 200)
            self.assertEqual(self.request("session", host="box.tail.ts.net:8317")[0], 200)
            self.assertEqual(self.request("session", host="evil.example")[0], 403)

    def test_sign_in_rate_limit_uses_forwarded_visitor_address(self):
        self.hub.login_attempts.clear()
        # tailscale serve appends the visitor on the right; a spoofed left entry must not count.
        attacker = {"X-Forwarded-For": "1.2.3.4, 100.64.0.9"}
        for i in range(10):
            self.request("login", {"key": "wrong"}, extra={"X-Forwarded-For": "9.9.9.%d, 100.64.0.9" % i})
        self.assertEqual(self.request("login", {"key": "test-only-key"}, extra=attacker)[0], 429)
        # The proxy's loopback address isn't locked out for everyone else.
        self.assertEqual(self.request("login", {"key": "test-only-key"}, extra={"X-Forwarded-For": "100.64.0.10"})[0], 200)
        # Without DASHBOARD_TRUST_CF, CF-Connecting-IP cannot pick a fresh bucket.
        self.hub.login_attempts.clear()
        for i in range(10):
            self.request("login", {"key": "wrong"}, extra={"CF-Connecting-IP": "203.0.113.%d" % i})
        self.assertEqual(self.request("login", {"key": "test-only-key"}, extra={"CF-Connecting-IP": "203.0.113.99"})[0], 429)
        self.hub.login_attempts.clear()

    def test_pause_calls_only_selected_account(self):
        cookie = self.login()
        with patch.object(self.hub, "request", return_value={"ok": True}) as request, patch.object(self.hub, "read_files"):
            result = self.request("account/status", {"id": "a", "disabled": True}, cookie=cookie)
        self.assertEqual(result[0], 200)
        request.assert_called_once_with("credentials/status", {"name": "a.json", "auth_index": "a", "disabled": True}, "PATCH")

    def test_cap_override_is_limited_to_registry_accounts(self):
        cookie = self.login()
        self.assertEqual(self.request("account/cap", {"id": "silo:a.json", "cap_percent": 50})[0], 401)  # needs a session
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "reg.json"
            path.write_text(json.dumps([{"seat": "s1", "provider": "codex",
                "node": "n", "silo_cpa_base": "http://silo-cpa-n:8443", "cpakey": "k", "hub_auth_name": "a.json"}]))
            with patch.object(dashboard_server, "SILO_REGISTRY", path):
                # An auth-file id is never a Silo account (Silo accounts are config api-key entries).
                self.assertEqual(self.request("account/cap", {"id": "a", "cap_percent": 50}, cookie=cookie)[0], 400)
                self.assertEqual(self.request("account/cap", {"id": "silo:other", "cap_percent": 50}, cookie=cookie)[0], 400)
                self.assertEqual(self.request("account/cap", {"id": "silo:a.json", "cap_percent": 0}, cookie=cookie)[0], 400)  # out of range
                self.assertEqual(self.request("account/cap", {"id": "silo:a.json", "cap_percent": 50}, cookie=cookie)[1], {"cap_percent": 50})
                self.assertEqual(self.hub.store.cap_overrides(), {"a.json": 50})
                self.assertEqual(self.request("account/cap", {"id": "silo:a.json", "cap_percent": None}, cookie=cookie)[1], {"cap_percent": None})
                self.assertEqual(self.hub.store.cap_overrides(), {})

    def test_group_cap_override_api_applies_and_clears_independently(self):
        cookie = self.login()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "reg.json"
            path.write_text(json.dumps([silo_entry("u1", "antigravity", cap_percent=85)]))
            api = FakeHubAPI(groups=[{"name": "u1", "disabled": False, "keys": [{"api-key": "A"}]}],
                             family="openai-compatibility", account="u1")
            future = time.time() + 3600
            windows = [group_window("Claude & GPT", 88, future), group_window("Gemini", 0, future)]
            body = {"id": "silo:u1", "group": "Claude & GPT", "cap_percent": 95}
            with patch.object(dashboard_server, "SILO_REGISTRY", path), \
                    patch.object(self.hub, "request", side_effect=api), \
                    patch.object(self.hub, "_remote_fetch", return_value=(88, future, windows)):
                self.hub.enforce_caps()
                group = api.config[api.family][0]
                self.assertEqual(group["excluded-models"], ["claude-*", "gpt-*"])
                self.hub.wake.clear()
                self.assertEqual(self.request("account/cap", body, cookie=cookie)[:2],
                                 (200, {"cap_percent": 95, "group": "Claude & GPT"}))
                self.assertTrue(self.hub.wake.is_set())
                self.assertEqual(self.hub.store.cap_group_overrides(), {"u1": {"Claude & GPT": 95}})
                self.assertEqual(self.hub.store.cap_overrides(), {})
                self.hub.enforce_caps()
                self.assertNotIn("excluded-models", api.config[api.family][0])
                self.assertEqual(self.hub.store.cap_group_state(), {})

                for bad in (False, 0, [], {}, "x" * 65, "line\nbreak", "nul\x00", "delete\x7f", "c1\x85"):
                    with self.subTest(group=bad):
                        self.assertEqual(self.request("account/cap", {**body, "group": bad}, cookie=cookie)[0], 400)
                for blank in (None, ""):
                    self.assertEqual(self.request("account/cap", {**body, "group": blank}, cookie=cookie)[:2],
                                     (200, {"cap_percent": 95}))
                self.assertEqual(self.hub.store.cap_overrides(), {"u1": 95})
                self.request("account/cap", {"id": "silo:u1", "cap_percent": None}, cookie=cookie)
                self.assertEqual(self.request("account/cap", {**body, "cap_percent": None}, cookie=cookie)[:2],
                                 (200, {"cap_percent": None, "group": "Claude & GPT"}))
                self.assertEqual(self.hub.store.cap_group_overrides(), {})
                self.hub.enforce_caps()
                self.assertEqual(api.config[api.family][0]["excluded-models"], ["claude-*", "gpt-*"])

    def test_owner_pause_of_a_silo_account_writes_its_api_keys_entry(self):
        cookie = self.login()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "reg.json"
            path.write_text(json.dumps([silo_entry()]))
            api = FakeHubAPI()
            with patch.object(dashboard_server, "SILO_REGISTRY", path), patch.object(self.hub, "request", side_effect=api):
                result = self.request("account/status", {"id": "silo:s1", "disabled": True}, cookie=cookie)
            self.assertEqual(result[0], 200)
            self.assertEqual(api.writes, [("s1", True)])  # no credentials/status call (it would 404 / no-op)
            self.assertEqual(self.hub.store.cap_state()["s1"]["label"], dashboard_server.OWNER_PAUSE)

    def test_oauth_callback_is_bound_to_session_and_state(self):
        cookie = self.login()
        token = cookie.split("=", 1)[1]
        self.hub.oauth["state-a"] = {"provider": "codex", "session": token, "created": time.time()}
        other = self.login()
        self.assertEqual(self.request("oauth/status", {"state": "state-a"}, cookie=other)[0], 400)
        with patch.object(self.hub, "request", return_value={"status": "ok"}) as request:
            self.assertEqual(self.request("oauth/callback", {"state": "state-a", "redirect_url": "http://localhost/callback?state=wrong&code=abc"}, cookie=cookie)[0], 400)
            request.assert_not_called()
            self.assertEqual(self.request("oauth/callback", {"state": "state-a", "redirect_url": "http://localhost/callback?state=state-a&code=abc"}, cookie=cookie)[0], 200)


    # --- Account actions and logs ---------------------------------------------------

    def test_relogin_targets_existing_credential_and_binds_state(self):
        cookie = self.login()
        token = cookie.split("=", 1)[1]
        with patch.object(self.hub, "request", return_value={"url": "https://auth.example/x", "state": "re-1", "status": "ok"}) as request:
            status, data, _ = self.request("account/relogin", {"id": "a"}, cookie=cookie)
        self.assertEqual(status, 200)
        self.assertEqual(data, {"url": "https://auth.example/x", "state": "re-1"})
        request.assert_called_once_with("oauth/auth-url", {"provider": "codex", "auth_index": "a", "is_webui": True}, "POST")
        self.assertEqual(self.hub.oauth["re-1"]["account"], "a")
        self.assertEqual(self.hub.oauth["re-1"]["session"], token)

    def test_account_actions_reject_unknown_accounts(self):
        cookie = self.login()
        with patch.object(self.hub, "request") as request:
            for action in ["relogin", "cooldown", "remove"]:
                self.assertEqual(self.request(f"account/{action}", {"id": "missing"}, cookie=cookie)[0], 404)
        request.assert_not_called()

    def test_reset_options_replaces_externally_spent_credit_without_consuming(self):
        self.hub.quotas["a"] = {"resets": {"available": 2}}
        cookie = self.login()
        response = {"credits": [{"id": "remaining", "reset_type": "codex_rate_limits",
                                 "status": "available", "expires_at": time.time() + 600}]}
        with patch.object(self.hub, "call", return_value=(200, response)) as call:
            status, options, _ = self.request("account/reset-options", {"id": "a"}, cookie=cookie)
        self.assertEqual((status, options["available"], options["items"][0]["id"]), (200, 1, "remaining"))
        self.assertEqual(self.hub.quotas["a"]["resets"], options)
        call.assert_called_once()
        self.assertEqual(call.call_args.args[1], "GET")

    def test_cooldown_reset_uses_auth_index_and_refreshes(self):
        cookie = self.login()
        self.hub.wake.clear()
        with patch.object(self.hub, "request", return_value={"status": "ok"}) as request:
            status, data, _ = self.request("account/cooldown", {"id": "a"}, cookie=cookie)
        self.assertEqual((status, data), (200, {"status": "ok"}))
        request.assert_called_once_with("routing/cooldown/reset", {"auth_index": "a"}, "POST")
        self.assertTrue(self.hub.wake.is_set())

    def test_remove_deletes_one_named_file_and_forgets_latest(self):
        cookie = self.login()
        self.hub.quotas["a"] = {"observed_at": time.time(), "windows": []}
        self.hub.store.save("a", "codex", self.hub.quotas["a"])
        with patch.object(self.hub, "request", return_value={"status": "ok"}) as request, patch.object(self.hub, "read_files"):
            status, data, _ = self.request("account/remove", {"id": "a"}, cookie=cookie)
        self.assertEqual((status, data), (200, {"status": "ok"}))
        request.assert_called_once_with("credentials?name=a.json", method="DELETE")
        self.assertNotIn("all", request.call_args.args[0])
        self.assertNotIn("a", self.hub.quotas)
        self.assertNotIn("a", self.hub.store.load())

    def test_remove_refuses_unsafe_file_names(self):
        cookie = self.login()
        original = self.hub.files
        self.hub.files = [{"auth_index": "a", "name": "../a.json", "provider": "codex"}]
        try:
            with patch.object(self.hub, "request") as request:
                self.assertEqual(self.request("account/remove", {"id": "a"}, cookie=cookie)[0], 400)
            request.assert_not_called()
        finally:
            self.hub.files = original

    def test_rename_needs_session_and_csrf_and_validates(self):
        self.assertEqual(self.request("account/rename", {"id": "a", "nickname": "x"})[0], 401)
        cookie = self.login()
        self.assertEqual(self.request("account/rename", {"id": "a", "nickname": "x"}, cookie=cookie, origin="https://evil.example")[0], 403)
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port)
        conn.request("POST", "/dashboard/api/account/rename", body=b"{}", headers={"Host": "localhost:8318", "Cookie": cookie})
        self.assertEqual(conn.getresponse().status, 403)
        conn.close()
        self.assertEqual(self.request("account/rename", {"id": "missing", "nickname": "x"}, cookie=cookie)[0], 404)
        self.assertEqual(self.request("account/rename", {"id": "a", "nickname": "x" * 41}, cookie=cookie)[0], 400)
        self.assertEqual(self.request("account/rename", {"id": "a", "nickname": 5}, cookie=cookie)[0], 400)
        self.assertEqual(self.request("account/rename", {"id": "a", "nickname": "badname"}, cookie=cookie)[0], 400)
        self.assertEqual(self.hub.store.nicknames(), {})

    def test_rename_trims_clears_and_shows_in_snapshot(self):
        cookie = self.login()
        status, data, _ = self.request("account/rename", {"id": "a", "nickname": "  Work <b>  "}, cookie=cookie)
        self.assertEqual((status, data), (200, {"nickname": "Work <b>"}))
        self.assertEqual(self.request("snapshot", cookie=cookie)[1]["accounts"][0]["nickname"], "Work <b>")
        self.assertEqual(self.hub.store.nicknames(), {"a.json": "Work <b>"})
        self.assertEqual(self.request("account/rename", {"id": "a", "nickname": "   "}, cookie=cookie)[0], 200)
        self.assertEqual(self.request("snapshot", cookie=cookie)[1]["accounts"][0]["nickname"], "")
        self.assertEqual(self.hub.store.nicknames(), {})

    def test_codex_login_turns_on_websockets_once(self):
        cookie = self.login()
        with self.hub.lock:
            self.hub.oauth["st1"] = {"provider": "codex", "session": cookie.split("=", 1)[1], "created": time.time()}
        ok = {"status": "ok", "auth_id": "codex-new.json"}
        with patch.object(self.hub, "request", return_value=ok) as request:
            self.assertEqual(self.request("oauth/status", {"state": "st1"}, cookie=cookie)[0], 200)
            self.assertEqual(self.request("oauth/status", {"state": "st1"}, cookie=cookie)[0], 200)
        patches = [c for c in request.call_args_list if c.args[0] == "credentials/fields"]
        self.assertEqual(len(patches), 1)
        self.assertEqual(patches[0].args, ("credentials/fields", {"name": "codex-new.json", "websockets": True}, "PATCH"))
        with self.hub.lock:
            self.hub.oauth.pop("st1", None)

    def test_account_detail_for_devin_and_xai_reports_priority_and_no_subscription(self):
        devin = dashboard_server.account_detail({"name": "devin-x.json", "provider": "devin", "priority": -1})
        self.assertEqual((devin["priority"], devin["provider_fields"]), (-1, {}))
        xai = dashboard_server.account_detail({"name": "xai-x.json", "provider": "xai", "priority": True})
        self.assertIsNone(xai["priority"])
        self.assertIsNone(dashboard_server.account_detail({"name": "n.json", "provider": "devin"})["priority"])
        safe = safe_account({"auth_index": "d", "provider": "devin", "email": "d@x.y", "name": "devin-x.json"})
        self.assertEqual((safe["provider"], safe["plan"], safe["windows"]), ("devin", "Unknown", []))

    def test_devin_login_becomes_overflow_once_and_antigravity_stays_normal(self):
        cookie = self.login()
        token = cookie.split("=", 1)[1]
        for provider, expect in (("devin", {"priority": -1}), ("antigravity", None), ("xai", None)):
            state = "st-" + provider
            with self.hub.lock:
                self.hub.oauth[state] = {"provider": provider, "session": token, "created": time.time()}
            with patch.object(self.hub, "request", return_value={"status": "ok", "auth_id": provider + ".json"}) as request:
                self.request("oauth/status", {"state": state}, cookie=cookie)
                self.request("oauth/status", {"state": state}, cookie=cookie)
            patches = [c for c in request.call_args_list if c.args[0] == "credentials/fields"]
            if expect is None:
                self.assertEqual(patches, [])
            else:
                self.assertEqual([c.args for c in patches], [("credentials/fields", {"name": provider + ".json", **expect}, "PATCH")])
            with self.hub.lock:
                self.hub.oauth.pop(state, None)

    def test_priority_is_first_normal_or_overflow(self):
        cookie = self.login()
        self.assertEqual(self.request("account/priority", {"id": "a", "priority": 1})[0], 401)
        self.assertEqual(self.request("account/priority", {"id": "missing", "priority": 1}, cookie=cookie)[0], 404)
        for bad in ("yes", True, 2, -2, None):
            self.assertEqual(self.request("account/priority", {"id": "a", "priority": bad}, cookie=cookie)[0], 400, bad)
        with patch.object(self.hub, "request", return_value={"status": "ok"}) as request, patch.object(self.hub, "read_files"):
            for value in (1, 0, -1):
                self.assertEqual(self.request("account/priority", {"id": "a", "priority": value}, cookie=cookie)[1], {"priority": value})
        self.assertEqual([c.args for c in request.call_args_list],
                         [("credentials/fields", {"name": "a.json", "priority": v}, "PATCH") for v in (1, 0, -1)])

    def test_provider_order_is_stored_for_every_device_and_checked(self):
        self.assertEqual(self.request("provider-order")[0], 401)
        self.assertEqual(self.request("provider-order", {"order": ["xai"]})[0], 401)
        cookie = self.login()
        self.assertEqual(self.request("provider-order", {"order": ["xai"]}, cookie=cookie, origin="https://evil.example")[0], 403)
        for bad in ("codex", [1], ["Bad Name"], ["a"] * 31, None):
            self.assertEqual(self.request("provider-order", {"order": bad}, cookie=cookie)[0], 400, bad)
        status, data, _ = self.request("provider-order", {"order": ["xai", "claude", "xai", "codex"]}, cookie=cookie)
        self.assertEqual((status, data), (200, {"order": ["xai", "claude", "codex"]}))
        self.assertEqual(self.request("provider-order", cookie=cookie)[1], {"order": ["xai", "claude", "codex"]})
        self.assertEqual(self.request("snapshot", cookie=cookie)[1]["provider_order"], ["xai", "claude", "codex"])
        # a second Hub on the same database (another device after a restart) sees the same order
        other = Hub(Store(Path(self.folder.name) / "test.sqlite"))
        self.assertEqual(other.store.provider_order(), ["xai", "claude", "codex"])
        self.hub.store.set_setting("provider_order", [])

    def test_account_pages_serve_the_app_only_with_a_clean_id(self):
        for path in ("/dashboard/accounts/288c0f5a9cd2e58a", "/dashboard/accounts/a.json"):
            conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port)
            conn.request("GET", path, headers={"Host": "localhost:8318"})
            res = conn.getresponse()
            self.assertEqual(res.status, 200)
            self.assertIn(b"<html", res.read().lower())
            conn.close()
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port)
        conn.request("GET", "/dashboard/accounts/a/b", headers={"Host": "localhost:8318"})
        self.assertNotEqual(conn.getresponse().status, 200)
        conn.close()

    def test_snapshot_detail_needs_a_session(self):
        self.assertEqual(self.request("snapshot")[0], 401)
        cookie = self.login()
        detail = self.request("snapshot", cookie=cookie)[1]["accounts"][0]["detail"]
        self.assertEqual(detail["file"], "a.json")

    def test_error_log_list_and_file(self):
        cookie = self.login()
        listing = {"files": [{"name": "error-1.log", "size": 10, "modified": 5, "path": "/secret"},
                             {"name": "../etc/passwd", "size": 1, "modified": 1}]}
        with patch.object(self.hub, "request", return_value=listing):
            status, data, _ = self.request("logs/errors", cookie=cookie)
        self.assertEqual((status, data), (200, {"files": [{"name": "error-1.log", "size": 10, "modified": 5}]}))
        with patch.object(self.hub, "request") as request:
            self.assertEqual(self.request("logs/errors/file?name=../x.log", cookie=cookie)[0], 400)
        request.assert_not_called()
        big = b"POST /v1/responses\n" + b"x" * ERROR_LOG_LIMIT
        with patch.object(self.hub, "request", return_value=big) as request:
            status, data, _ = self.request("logs/errors/file?name=error-1.log", cookie=cookie)
        request.assert_called_once_with("observability/logs/errors/error-1.log", raw=True)
        self.assertEqual(status, 200)
        self.assertTrue(data["truncated"])
        self.assertTrue(data["text"].startswith("POST /v1/responses"))
        self.assertEqual(len(data["text"]), ERROR_LOG_LIMIT)
        with patch.object(self.hub, "request", side_effect=ProxyError(404, b"{}")):
            self.assertEqual(self.request("logs/errors/file?name=error-1.log", cookie=cookie)[0], 404)

    def test_activity_log_reports_disabled_and_passes_paging(self):
        cookie = self.login()
        with patch.object(self.hub, "request", side_effect=ProxyError(400, b'{"error":"logging to file disabled"}')):
            status, data, _ = self.request("logs/activity", cookie=cookie)
        self.assertEqual((status, data), (200, {"enabled": False, "lines": []}))
        result = {"lines": ["[2026-11-13 03:00:00] ok"], "line-count": 1, "latest-timestamp": 1794500000, "next-cursor": "c2"}
        with patch.object(self.hub, "request", return_value=result) as request:
            status, data, _ = self.request("logs/activity?after=1794499999&limit=9999", cookie=cookie)
        request.assert_called_once_with("observability/logs?limit=500&after=1794499999")
        self.assertEqual(data, {"enabled": True, "lines": result["lines"], "latest": 1794500000, "next_cursor": "c2"})
        with patch.object(self.hub, "request", side_effect=ProxyError(500, b"boom")):
            self.assertEqual(self.request("logs/activity", cookie=cookie)[0], 400)

    def test_enable_activity_log_sets_only_logging_to_file(self):
        cookie = self.login()
        with patch.object(self.hub, "request", return_value=None) as request:
            status, data, _ = self.request("logs/activity/enable", {}, cookie=cookie)
        self.assertEqual((status, data), (200, {"enabled": True}))
        request.assert_called_once_with("config/observability/logs/logging-to-file", True, "PUT")

    def test_mutations_require_csrf_header(self):
        cookie = self.login()
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port)
        with patch.object(self.hub, "request") as request:
            conn.request("POST", "/dashboard/api/account/remove", body=json.dumps({"id": "a"}),
                         headers={"Host": "localhost:8318", "Cookie": cookie, "Content-Type": "application/json"})
            self.assertEqual(conn.getresponse().status, 403)
        conn.close()
        request.assert_not_called()

    # --- Client keys ---------------------------------------------------------------

    KEY = {"id": "ck_0123456789ab", "name": "alice", "hint": "abcd", "enabled": True, "providers": ["codex"],
           "accounts": [], "models": ["gpt-5*"], "weekly_token_limit": 5000000, "weekly_tokens": 1200,
           "created_at": "2026-11-15T00:00:00Z", "updated_at": "2026-11-15T00:00:00Z"}
    SECRET = "cpk_" + "a1" * 24

    def test_client_keys_need_a_session_and_csrf_checks(self):
        with patch.object(self.hub, "request") as request:
            self.assertEqual(self.request("keys")[0], 401)
            self.assertEqual(self.request("keys/usage")[0], 401)
            self.assertEqual(self.request("keys/create", {"name": "alice"})[0], 401)
            cookie = self.login()
            self.assertEqual(self.request("keys/create", {"name": "alice"}, cookie=cookie, origin="https://evil.example")[0], 403)
            conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port)
            conn.request("POST", "/dashboard/api/keys/delete", body=json.dumps({"id": self.KEY["id"]}),
                         headers={"Host": "localhost:8318", "Cookie": cookie, "Content-Type": "application/json"})
            self.assertEqual(conn.getresponse().status, 403)
            conn.close()
        request.assert_not_called()

    def test_client_key_input_is_validated_before_the_proxy(self):
        cookie = self.login()
        bad = [("keys/create", {}), ("keys/create", {"name": "  "}), ("keys/create", {"name": "a\nb"}),
               ("keys/create", {"name": "x" * 81}),
               ("keys/create", {"name": "a", "weekly_token_limit": -1}),
               ("keys/create", {"name": "a", "weekly_token_limit": True}),
               ("keys/create", {"name": "a", "weekly_token_limit": "5M"}),
               ("keys/create", {"name": "a", "weekly_token_limit": 10**16}),
               ("keys/create", {"name": "a", "models": ["gpt 5"]}),
               ("keys/create", {"name": "a", "models": "gpt-5"}),
               ("keys/create", {"name": "a", "providers": ["Codex/../x"]}),
               ("keys/create", {"name": "a", "enabled": "yes"}),
               ("keys/update", {"id": self.KEY["id"]}),
               ("keys/update", {"id": "../config", "name": "a"}),
               ("keys/rotate", {"id": "ck_ABC"}), ("keys/delete", {}),
               ("keys/usage?key=ck_x/../y", None)]
        with patch.object(self.hub, "request") as request:
            for path, body in bad:
                status, data, _ = self.request(path, body, cookie=cookie)
                self.assertEqual(status, 400, (path, body))
                self.assertIn("error", data)
        request.assert_not_called()

    def test_client_key_create_sends_clean_fields_and_returns_the_secret_once(self):
        cookie = self.login()
        result = {"key": {**self.KEY, "hash": "deadbeef"}, "secret": self.SECRET}
        with patch.object(self.hub, "request", return_value=result) as request:
            status, data, _ = self.request("keys/create", {
                "name": " alice ", "providers": ["Codex", "codex"], "accounts": ["codex-a@b.json"],
                "models": ["GPT-5*"], "weekly_token_limit": 5000000, "extra": "ignored"}, cookie=cookie)
        self.assertEqual(status, 201)
        request.assert_called_once_with("access/client-keys", {
            "name": "alice", "providers": ["codex"], "accounts": ["codex-a@b.json"], "models": ["gpt-5*"],
            "weekly_token_limit": 5000000}, "POST")
        self.assertEqual(data["secret"], self.SECRET)
        self.assertNotIn("hash", data["key"])
        self.assertEqual(data["key"]["hint"], "abcd")
        # A malformed secret from the proxy is not passed on.
        with patch.object(self.hub, "request", return_value={"key": self.KEY, "secret": "oops"}):
            self.assertEqual(self.request("keys/create", {"name": "a"}, cookie=cookie)[0], 400)

    def test_client_key_secret_is_only_returned_by_create_and_rotate(self):
        cookie = self.login()
        leaky = {**self.KEY, "secret": self.SECRET, "hash": "deadbeef"}
        with patch.object(self.hub, "request", return_value={"keys": [leaky]}) as request:
            status, data, _ = self.request("keys", cookie=cookie)
        request.assert_called_once_with("access/client-keys")
        self.assertEqual(status, 200)
        self.assertEqual(data["keys"], [self.KEY])
        self.assertNotIn(self.SECRET, json.dumps(data))
        with patch.object(self.hub, "request", return_value={"key": leaky, "secret": self.SECRET}) as request:
            status, data, _ = self.request("keys/update", {"id": self.KEY["id"], "enabled": False,
                                                          "weekly_token_limit": 0}, cookie=cookie)
        request.assert_called_once_with(f"access/client-keys/{self.KEY['id']}", {"enabled": False, "weekly_token_limit": 0}, "PATCH")
        self.assertEqual(status, 200)
        self.assertNotIn(self.SECRET, json.dumps(data))
        with patch.object(self.hub, "request", return_value={"key": self.KEY, "secret": self.SECRET}) as request:
            status, data, _ = self.request("keys/rotate", {"id": self.KEY["id"]}, cookie=cookie)
        request.assert_called_once_with(f"access/client-keys/{self.KEY['id']}/rotate", {}, "POST")
        self.assertEqual((status, data["secret"]), (200, self.SECRET))
        with patch.object(self.hub, "request", return_value={"status": "ok"}) as request:
            status, data, _ = self.request("keys/delete", {"id": self.KEY["id"]}, cookie=cookie)
        request.assert_called_once_with(f"access/client-keys/{self.KEY['id']}", method="DELETE")
        self.assertEqual((status, data), (200, {"status": "ok"}))

    def test_client_key_usage_and_options_pass_only_known_fields(self):
        cookie = self.login()
        bucket = {"key_id": self.KEY["id"], "hour": "2026-11-15T05:00:00Z", "provider": "codex", "account": "a",
                  "model": "gpt-5", "requests": 3, "failed": 1, "input_tokens": 300, "output_tokens": 150,
                  "cache_read_tokens": 20, "cache_write_tokens": 9, "tokens": 450, "client_ip": "203.0.113.9"}
        with patch.object(self.hub, "request", return_value={"since": "2026-11-08T06:00:00Z", "buckets": [bucket]}) as request:
            status, data, _ = self.request(f"keys/usage?hours=99999&key={self.KEY['id']}", cookie=cookie)
        request.assert_called_once_with(f"access/client-keys/usage?hours=2160&key={self.KEY['id']}")
        self.assertEqual(status, 200)
        self.assertEqual(data["buckets"][0]["hour"], 1794718800.0)
        self.assertEqual(data["buckets"][0]["tokens"], 450)
        self.assertEqual(data["buckets"][0]["cache_write_tokens"], 9)
        self.assertEqual(self.request("keys/usage?hours=720")[0], 401)
        self.assertNotIn("client_ip", data["buckets"][0])
        options = {"providers": ["codex"], "accounts": [{"id": "a", "provider": "codex", "label": "a@b", "disabled": False,
                                                         "token": "secret"}], "models": [{"id": "gpt-5", "providers": ["codex"]}]}
        with patch.object(self.hub, "request", return_value=options):
            status, data, _ = self.request("keys/options", cookie=cookie)
        self.assertEqual(status, 200)
        self.assertNotIn("token", data["accounts"][0])

    def test_client_key_proxy_errors_are_explained(self):
        cookie = self.login()
        with patch.object(self.hub, "request", side_effect=ProxyError(404, b'{"error":"client key not found"}')):
            status, data, _ = self.request("keys/delete", {"id": self.KEY["id"]}, cookie=cookie)
        self.assertEqual(status, 404)
        self.assertIn("no longer exists", data["error"])
        with patch.object(self.hub, "request", side_effect=ProxyError(404, b"404 page not found")):
            status, data, _ = self.request("keys", cookie=cookie)
        self.assertEqual(status, 502)
        self.assertIn("Update CLIProxyAPI", data["error"])

    def test_all_time_token_usage_persists_raw_buckets_and_includes_old_imports(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(self.server, "hub", Hub(Store(Path(folder) / "usage.sqlite"))) as hub:
            hub.management_key = self.hub.management_key
            cookie = self.login()
            store = hub.store
            now = int(time.time()) // 3600 * 3600
            old = now - 100 * 86400
            with store.connect() as db:
                db.execute("INSERT INTO tokens_imported VALUES (?,?,?,?,?,?,?,?,?,?)",
                           (old - 3600, "codex", "legacy", "m", 1, 0, 50, 20, 0, 0))
            raw = {"key_id": "ck_one", "hour": old, "model": "m", "provider": "openai-compatible-a1",
                   "account": "openai-compatibility:a1:old", "tokens": 12, "client_ip": "private"}
            other = {**raw, "key_id": "ck_two", "account": "oauth", "provider": "codex"}
            with patch.object(dashboard_server, "load_registry", return_value=[]), patch.object(
                    hub, "request", side_effect=[{"buckets": [raw, other]}, {}]) as proxy:
                status, data, _ = self.request("keys/usage?hours=1", cookie=cookie)
            self.assertEqual(proxy.call_args_list, [call("access/client-keys/usage?hours=1"), call("config/api-keys")])
            self.assertEqual(status, 200)
            self.assertCountEqual([b["account"] for b in data["buckets"]], ["a1", "oauth"])
            self.assertEqual(store.live_buckets(key_id="ck_one")[0]["account"], raw["account"])

            recent = {**raw, "hour": now}
            with patch.object(dashboard_server, "load_registry", return_value=[]), patch.object(
                    hub, "request", return_value={"since": now - 90 * 86400,
                                                  "buckets": [recent, {**raw, "hour": None}]}) as proxy:
                status, data, _ = self.request("keys/usage?all=1", cookie=cookie)
            proxy.assert_called_once_with("access/client-keys/usage?hours=2160&all=1")
            self.assertEqual((status, data["since"]), (200, old - 3600))
            self.assertCountEqual([(b["key_id"], b["hour"]) for b in data["buckets"]],
                                  [("imported", old - 3600), ("ck_one", old), ("ck_two", old), ("ck_one", now)])
            self.assertTrue(all("client_ip" not in b for b in data["buckets"]))

            with patch.object(dashboard_server, "load_registry", return_value=[]), patch.object(
                    hub, "request", return_value={"buckets": [{**recent, "tokens": 24}]}) as proxy:
                status, data, _ = self.request("keys/usage?all=TrUe&key=ck_one", cookie=cookie)
            proxy.assert_called_once_with("access/client-keys/usage?hours=2160&all=1&key=ck_one")
            self.assertEqual((status, data["since"]), (200, old))
            self.assertCountEqual([(b["hour"], b["tokens"], b["account"]) for b in data["buckets"]],
                                  [(old, 12, "a1"), (now, 24, "a1")])
            saved, = Store(store.path).live_buckets(since=now, key_id="ck_one")
            self.assertEqual((saved["account"], saved["provider"], saved["tokens"]), (raw["account"], raw["provider"], 24))
            with patch.object(hub, "request", return_value={"since": old}):
                status, data, _ = self.request("keys/usage?all=1&key=ck_empty", cookie=cookie)
            self.assertEqual((status, data), (200, {"since": old, "buckets": []}))


class UsageAliasTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.store = Store(Path(folder.name) / "test.sqlite")
        self.hub = Hub(self.store)

    def test_config_ids_match_stable_hashes_and_survive_removal(self):
        registry = [{"hub_auth_name": name, "provider": family}
                    for name, family in [("C1", "claude"), ("X1", "codex"), ("A1", "antigravity")]]
        config = {
            "claude": [{"name": "c1", "base-url": "https://claude.example", "prefix": "group-prefix",
                        "proxy-url": "http://proxy.example", "headers": {"Z": "two", "A": "one"},
                        "connection-pool": {"enabled": True, "idle-conn-timeout": " 45s ", "max-idle-conns-per-host": 4},
                        "keys": [{"api-key": " sample-c ", "prefix": "per-key",
                                  "connection-pool": {"max-idle-conns-per-host": 0}}]}],
            "codex": [{"name": "x1", "base-url": "https://codex.example", "prefix": "group-prefix",
                       "headers": {"Group": "replaced"}, "connection-pool": {"enabled": True, "idle-conn-timeout": "1m"},
                       "keys": [{"api-key": "sample-x", "headers": {"K": "key-only"},
                                 "connection-pool": {"enabled": False, "max-idle-conns-per-host": 7}}]}],
            "openai-compatibility": [
                {"name": " a1 ", "base-url": "https://compat.example", "connection-pool": {"enabled": True},
                 "api-key-entries": [{"api-key": "sample-a", "proxy-url": "http://key-proxy.example",
                                      "connection-pool": {"idle-conn-timeout": "30s", "max-idle-conns-per-host": 3}}]},
                {"name": "Local", "base-url": "https://local.example", "connection-pool": {}, "keys": []}],
        }
        config["claude"].append({**config["claude"][0], "name": "second"})
        expected = {
            "claude:apikey:5d4435b3e8a8": ("silo:C1", "claude", "C1"),
            "claude:apikey:5d4435b3e8a8-1": ("second", "claude", "second"),
            "codex:apikey:c1e58cf8dea4": ("silo:X1", "codex", "X1"),
            "openai-compatibility:a1:c5360ba2ee8f": ("silo:A1", "antigravity", "A1"),
            "openai-compatibility:local:536639c80403": ("Local", "openai-compatible", "Local"),
        }
        for family, auth_id in [("gemini", "gemini:apikey:5013a45356b1"), ("interactions", "gemini-interactions:apikey:8295ab21486f"),
                                ("meta", "meta:apikey:3c449a0a9e99"), ("xai", "xai:apikey:5adf1382436c"),
                                ("vertex", "vertex:apikey:16eaa28a964a")]:
            config[family] = [{"prefix": "example", "keys": [{"api-key": "sample"}]}]
            expected[auth_id] = ("example", family, "example")
        buckets = [{"account": auth_id, "provider": "raw"} for auth_id in expected]
        with patch.object(dashboard_server, "load_registry", return_value=registry), patch.object(
                self.hub, "request", return_value=config) as proxy:
            result = self.hub.normalize_usage_buckets(buckets)
        proxy.assert_called_once_with("config/api-keys")
        self.assertEqual([(b["account"], b["provider"]) for b in result], [v[:2] for v in expected.values()])
        self.assertEqual(self.store.account_aliases(), {k: dict(zip(("account", "provider", "label"), v))
                                                        for k, v in expected.items()})

        restarted = Hub(Store(self.store.path))
        with patch.object(restarted, "request", return_value={}) as proxy, patch.object(dashboard_server, "load_registry", return_value=[]):
            result = restarted.normalize_usage_buckets([{"account": next(iter(expected)), "provider": "raw"},
                                                       {"account": "claude:apikey:unknown", "provider": "claude"}])
        proxy.assert_called_once_with("config/api-keys")
        self.assertEqual(result[0], {"account": "silo:C1", "provider": "claude"})

    def test_rotated_compat_ids_and_provider_only_buckets_when_config_is_unavailable(self):
        buckets = [{"account": "openai-compatibility:a1:" + suffix, "provider": "raw"} for suffix in ("old", "new")]
        buckets.extend([{"account": "", "provider": "openai-compatible-A1"},
                        {"account": "oauth", "provider": "openai-compatible-a1"}])
        registry = [{"hub_auth_name": "A1", "provider": "antigravity"}]
        with patch.object(self.hub, "request", side_effect=RuntimeError("unavailable")) as proxy:
            with patch.object(dashboard_server, "load_registry", return_value=registry):
                result = self.hub.normalize_usage_buckets(copy.deepcopy(buckets))
            self.assertEqual([b["account"] for b in result], ["silo:A1"] * 3 + ["oauth"])
            self.assertEqual({b["provider"] for b in result}, {"antigravity"})
            with patch.object(dashboard_server, "load_registry", return_value=[]):
                result = self.hub.normalize_usage_buckets(copy.deepcopy(buckets))
                self.assertEqual([b["account"] for b in result], ["a1", "a1", "", "oauth"])
                self.assertEqual({b["provider"] for b in result}, {"openai-compatible"})
                self.store.save_account_aliases({"openai-compatibility:a1:previous": ("silo:A1", "antigravity", "A1")})
                result = self.hub.normalize_usage_buckets(copy.deepcopy(buckets[:2]))
                self.assertEqual(result, [{"account": "silo:A1", "provider": "antigravity"}] * 2)
        proxy.assert_called_once_with("config/api-keys")


class CooldownTests(unittest.TestCase):
    def test_cooldown_until_is_latest_retry(self):
        raw = {"auth_index": "a", "provider": "codex", "cooldowns": [
            {"reason": "quota", "retry_at": "2026-11-13T03:00:00Z"},
            {"reason": "quota", "retry_at": "2026-11-13T04:00:00Z"}]}
        with patch("server.time.time", return_value=1794542399):
            account = safe_account(raw)
            self.assertEqual(account["cooldown_until"], 1794542400.0)
            self.assertEqual(len(account["cooldowns"]), 1)
        with patch("server.time.time", return_value=1794542400):
            self.assertEqual(safe_account(raw)["cooldowns"], [])
        self.assertIsNone(safe_account({"auth_index": "b", "provider": "codex"})["cooldown_until"])


if __name__ == "__main__":
    unittest.main()


class CouncilR1Tests(unittest.TestCase):
    def test_user_agents_match_proxy(self):
        repo = Path(__file__).resolve().parent.parent
        go_claude = (repo / "internal/runtime/executor/helps/claude_device_profile.go").read_text(encoding="utf-8")
        go_codex = (repo / "internal/runtime/executor/codex_executor_request.go").read_text(encoding="utf-8")
        self.assertIn('"%s"' % dashboard_server.CLAUDE_UA, go_claude)
        self.assertIn('"%s"' % dashboard_server.CODEX_UA, go_codex)
        self.assertIn('"%s"' % dashboard_server.CODEX_ORIGINATOR, go_codex)

    def test_quota_reads_are_slow(self):
        for provider in ("claude", "codex", "antigravity", "devin"):
            self.assertGreaterEqual(dashboard_server.QUOTA_MIN_INTERVAL[provider], 300)


def silo_entry(name="s1", provider="claude", **extra):
    return {"seat": name, "provider": provider, "node": "lap", "silo_cpa_base": "http://remote-node.example:8443",
            "cpakey": "CPAKEY", "hub_auth_name": name, **extra}


def group_window(group, used, reset_at, window_id=None):
    return {"group": group, "id": window_id or group, "label": group, "remaining": 100 - used,
            "reset_at": reset_at, "period": 7 * 86400}


class FakeHubAPI:
    """The hub management API as the dashboard sees it for a Silo account (verified against the Go source):
    - the account is a CONFIG api-key group (api-keys.<provider>, name = hub_auth_name), so GET credentials
      never lists it (buildAuthFileEntryLocked drops entries without a path);
    - GET config/api-keys/<provider> returns the groups plus an ETag; PUT replaces the list whole and honours
      If-Match (412 on a stale tag);
    - Claude groups pause via "*" in excluded-models, OpenAI-compatibility groups via disabled."""

    def __init__(self, paused=False, groups=None, family="claude", account="s1"):
        key = {"api-key": "CPAKEY", "auth_index": "9", **({"excluded-models": ["*"]} if paused else {})}
        self.family, self.account = family, account
        self.config = {family: groups if groups is not None else
                       [{"name": "s1", "base-url": "http://remote-node.example:8443", "keys": [key]}]}
        self.files = [{"auth_index": "2", "name": "owner.json", "provider": "codex", "disabled": False}]
        self.version, self.writes, self.fail_put = 1, [], None

    def paused(self, name=None):
        group = next(g for g in self.config[self.family] if g["name"] == (name or self.account))
        if self.family == "openai-compatibility":
            return bool(group.get("disabled"))
        return all("*" in (k.get("excluded-models") or group.get("excluded-models") or []) for k in group["keys"])

    def __call__(self, path, data=None, method=None, raw=False, if_match=None, etag=False):
        tag = f'"v{self.version}"'
        if path == "credentials":
            return {"files": copy.deepcopy(self.files)}
        if path.startswith("config/api-keys/"):
            provider = path.rsplit("/", 1)[1]
            if method is None:
                if provider not in self.config:
                    raise ProxyError(404)
                body = copy.deepcopy(self.config[provider])
                return (body, tag) if etag else body
            if method == "PUT":
                if self.fail_put:
                    raise ProxyError(self.fail_put)
                if if_match is not None and if_match != tag:
                    raise ProxyError(412)
                self.config[provider] = copy.deepcopy(data)
                self.version += 1
                self.writes.append((self.account, self.paused()))
                return {"status": "ok"}
        raise AssertionError(f"unexpected management call {method or 'GET'} {path}")


class SiloCapTests(unittest.TestCase):
    def registry(self, folder, **kw):
        path = Path(folder) / "reg.json"
        path.write_text(json.dumps([silo_entry(**kw)]))
        return path

    def rig(self, folder, paused=False):
        hub = Hub(Store(Path(folder) / "h.sqlite"))
        api = FakeHubAPI(paused)
        hub.files = api.files  # what read_files would see: no Silo entry in it
        return hub, api

    def enforce(self, hub, path, api, usage, times=1):
        """Run enforce_caps against the fake management API with the laptop read stubbed:
        usage is (used, reset_at) or an exception."""
        fetch = patch.object(Hub, "fetch_remote_quota", side_effect=usage if isinstance(usage, Exception) else None,
                             return_value=None if isinstance(usage, Exception) else usage)
        with patch.object(dashboard_server, "SILO_REGISTRY", path), patch.object(hub, "request", side_effect=api), fetch as f:
            for _ in range(times):
                if isinstance(usage, Exception):  # a fresh read each poll (bypass the rate limit), failures add up
                    for r in hub.remote_quotas.values():
                        r["observed_at"] = 0
                else:
                    hub.remote_quotas.pop("s1", None)
                hub.enforce_caps()
        return f

    def owner(self, hub, path, api, disabled):
        with patch.object(dashboard_server, "SILO_REGISTRY", path), patch.object(hub, "request", side_effect=api):
            hub.owner_set_silo(dashboard_server.load_registry()[0], disabled)

    def test_cap_decision_covers_every_transition(self):
        cap = 85
        self.assertIsNone(dashboard_server.cap_decision(50, cap, False))           # under cap -> leave running
        self.assertEqual(dashboard_server.cap_decision(90, cap, False), "pause")     # at/over cap -> pause
        self.assertIsNone(dashboard_server.cap_decision(90, cap, True))            # capped, still over -> hold
        self.assertEqual(dashboard_server.cap_decision(70, cap, True), "unpause")  # valid below-cap reading
        self.assertIsNone(dashboard_server.cap_decision(None, cap, False))         # no reading, not capped
        self.assertIsNone(dashboard_server.cap_decision(None, cap, True))          # no reading -> hold (fail closed)

    def test_registry_defaults_cap_by_provider_and_drops_bad_entries(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "reg.json"
            path.write_text(json.dumps([
                silo_entry("s1"), silo_entry("c1", "codex", cap_percent=70),
                silo_entry("g1", "grok"),  # out of scope
                silo_entry("m1", mgmt_url="u", mgmt_key="k"),  # old fields are ignored, not required
                {**silo_entry("b1"), "silo_cpa_base": "file:///etc"},  # not an http base
                {**silo_entry("b2"), "seat": "../x"},  # seat goes into a query string
                silo_entry("c1", "codex", cap_percent=40),  # a repeated name: the first entry wins
                {"seat": "x"}]))  # missing fields
            with patch.object(dashboard_server, "SILO_REGISTRY", path):
                reg = dashboard_server.load_registry()
            self.assertEqual([(e["hub_auth_name"], e["cap_percent"]) for e in reg], [("s1", 85), ("c1", 70), ("m1", 85)])
            self.assertNotIn("mgmt_key", reg[2])

    def test_remote_quota_reads_the_laptop_quota_route_with_the_cpakey(self):
        import io
        import urllib.error
        class Reply:
            def __init__(self, body):
                self.body = body

            def __enter__(self):
                return io.BytesIO(json.dumps(self.body).encode())

            def __exit__(self, *a):
                return False
        with patch.object(dashboard_server.urllib.request, "urlopen", return_value=Reply({"used_percent": 42.5, "reset_at": 1800000000, "provider": "claude"})) as op:
            self.assertEqual(Hub.fetch_remote_quota(silo_entry()), (42.5, 1800000000))
        req = op.call_args[0][0]
        self.assertEqual(req.full_url, "http://remote-node.example:8443/silo-cpa/quota?seat=s1")
        self.assertEqual(req.get_header("Authorization"), "Bearer CPAKEY")  # inference key, not a management key
        for bad in ({"used_percent": "high"}, {"used_percent": -5}):
            with patch.object(dashboard_server.urllib.request, "urlopen", return_value=Reply(bad)):
                with self.assertRaises(ValueError):
                    Hub.fetch_remote_quota(silo_entry())
        err = urllib.error.HTTPError("u", 429, "busy", {}, None)
        with patch.object(dashboard_server.urllib.request, "urlopen", side_effect=err):
            with self.assertRaisesRegex(ValueError, "429"):
                Hub.fetch_remote_quota(silo_entry())

    def test_missing_registry_file_keeps_the_feature_inactive(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(dashboard_server, "SILO_REGISTRY", Path(folder) / "none.json"):
                self.assertEqual(dashboard_server.load_registry(), [])
                hub = Hub(Store(Path(folder) / "h.sqlite"))
                with patch.object(hub, "request") as api, patch.object(hub, "remote_usage") as poll:
                    hub.enforce_caps()
                api.assert_not_called()
                poll.assert_not_called()

    def test_enforce_pauses_over_cap_through_the_api_keys_entry_then_resumes(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.registry(folder)
            hub, api = self.rig(folder)
            future = time.time() + 3600
            self.enforce(hub, path, api, (90, future), times=2)  # second pass: "*" already set -> no second write
            self.assertEqual(api.writes, [("s1", True)])
            self.assertEqual(api.config["claude"][0]["keys"][0]["excluded-models"], ["*"])
            self.assertNotIn("auth_index", api.config["claude"][0]["keys"][0])  # read-only field not written back
            state = hub.store.cap_state()["s1"]
            self.assertEqual(state["capped_until"], future)
            self.assertTrue(state["label"].startswith("Capped until "))
            self.assertRegex(state["label"], r"^Capped until [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M$")
            self.assertEqual(state["reason"], "Weekly limit at 90% (85% cap)")
            self.assertEqual(api.files[0]["disabled"], False)  # the owner's auth file is untouched
            self.enforce(hub, path, api, (40, future))  # dropped below cap
            self.assertEqual(api.writes[-1], ("s1", False))
            self.assertEqual(api.config["claude"][0]["keys"][0]["excluded-models"], [])
            self.assertNotIn("s1", hub.store.cap_state())

    def test_pause_keeps_other_excluded_models_and_group_defaults(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.registry(folder)
            hub = Hub(Store(Path(folder) / "h.sqlite"))
            api = FakeHubAPI(groups=[{"name": "s1", "base-url": "http://b", "excluded-models": ["claude-opus-*"],
                                      "keys": [{"api-key": "A"}, {"api-key": "B", "excluded-models": ["x"]}]},
                                     {"name": "other", "base-url": "http://o", "keys": [{"api-key": "O"}]}])
            self.enforce(hub, path, api, (95, time.time() + 3600))
            keys = api.config["claude"][0]["keys"]
            self.assertEqual([k["excluded-models"] for k in keys], [["claude-opus-*", "*"], ["x", "*"]])
            self.assertNotIn("excluded-models", api.config["claude"][1]["keys"][0])  # other groups untouched
            self.enforce(hub, path, api, (10, time.time() + 3600))
            self.assertEqual([k["excluded-models"] for k in api.config["claude"][0]["keys"]], [["claude-opus-*"], ["x"]])

    def test_missing_hub_entry_is_a_visible_error_not_a_silent_no_op(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.registry(folder)
            hub = Hub(Store(Path(folder) / "h.sqlite"))
            for groups in ([], [{"name": "s1", "keys": [{"api-key": "a"}]}, {"name": "s1", "keys": [{"api-key": "b"}]}]):
                api = FakeHubAPI(groups=groups)  # gone, or ambiguous
                self.enforce(hub, path, api, (99, time.time() + 3600))
                self.assertEqual(api.writes, [])
                self.assertIn("no single entry named s1", hub.remote_quotas["s1"]["error"])
            api = FakeHubAPI()
            del api.config["claude"]  # the hub has no api-keys.claude at all (404)
            self.enforce(hub, path, api, (99, time.time() + 3600))
            self.assertIn("no single entry named s1", hub.remote_quotas["s1"]["error"])

    def test_refresh_never_reads_a_silo_account_with_the_hub_token_path(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.registry(folder)
            hub, api = self.rig(folder)
            api.files.append({"auth_index": "9", "name": "s1", "provider": "claude", "disabled": False})  # even if listed
            with patch.object(dashboard_server, "SILO_REGISTRY", path), patch.object(hub, "request", side_effect=api), \
                    patch.object(hub, "refresh_one") as one:
                hub.refresh()
            self.assertEqual([c.args[0]["name"] for c in one.call_args_list], ["owner.json"])

    def test_stale_etag_fails_the_write_and_records_no_cap(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.registry(folder)
            hub, api = self.rig(folder)

            def racing(path_, data=None, method=None, **kw):
                if method == "PUT":
                    api.version += 1  # another writer saved config between our read and write
                return api(path_, data, method, **kw)
            self.enforce(hub, path, racing, (95, time.time() + 3600))
            self.assertEqual(hub.remote_quotas["s1"]["error"], "Silo cap enforcement failed (HTTP 412).")
            self.assertNotIn("s1", hub.store.cap_state())
            self.assertFalse(api.paused())

    def test_passed_reset_needs_a_fresh_current_below_cap_reading_to_resume(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.registry(folder)
            hub, api = self.rig(folder, paused=True)
            past = time.time() - 1
            hub.store.set_cap_state("s1", past, "Capped by Silo until earlier")
            # A cached over-cap reading whose own reset has passed is not trusted: the laptop is re-read.
            hub.remote_quotas["s1"] = {"used": 99, "reset_at": past, "observed_at": time.time(), "error": None, "fails": 0}
            with patch.object(dashboard_server, "SILO_REGISTRY", path), patch.object(hub, "request", side_effect=api), \
                    patch.object(Hub, "fetch_remote_quota", return_value=(99, past)) as fetch:
                hub.enforce_caps()
            fetch.assert_called_once()
            self.assertEqual(api.writes, [])  # the clock alone never resumes: the fresh read is still over cap
            row = hub.store.cap_state()["s1"]
            self.assertGreater(row["capped_until"], time.time())  # expired hold relabelled one interval on
            self.assertNotEqual(row["label"], "Capped by Silo until earlier")
            self.enforce(hub, path, api, (10, time.time() - 5))
            self.assertEqual(api.writes, [])  # below cap but of a window already over: not a resume
            self.enforce(hub, path, api, ValueError("Laptop unreachable"))
            self.assertEqual(api.writes, [])  # unreadable after the reset: stays paused
            self.enforce(hub, path, api, (10, time.time() + 3600))
            self.assertEqual(api.writes, [("s1", False)])  # fresh, current, below cap
            self.assertNotIn("s1", hub.store.cap_state())

    def test_pause_with_a_passed_reset_holds_one_poll_interval(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.registry(folder)
            hub, api = self.rig(folder)
            before = time.time()
            self.enforce(hub, path, api, (95, before - 10))
            self.assertEqual(api.writes, [("s1", True)])
            until = hub.store.cap_state()["s1"]["capped_until"]
            self.assertGreaterEqual(until, before + dashboard_server.QUOTA_MIN_INTERVAL["claude"])

    def test_unreadable_quota_fails_closed_then_recovers(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.registry(folder)
            hub, api = self.rig(folder)
            self.enforce(hub, path, api, ValueError("Laptop unreachable"), times=2)
            self.assertEqual(api.writes, [])  # two failures: still live
            self.enforce(hub, path, api, ValueError("Laptop unreachable"))
            self.assertEqual(api.writes, [("s1", True)])  # third consecutive failure: paused
            self.assertEqual(hub.store.cap_state()["s1"]["label"], dashboard_server.SILO_UNREADABLE)
            self.assertEqual(hub.remote_quotas["s1"]["error"], "Laptop unreachable")  # visible on the reading
            self.enforce(hub, path, api, ValueError("Laptop unreachable"))
            self.assertEqual(api.writes, [("s1", True)])  # held, no flapping
            self.enforce(hub, path, api, (30, time.time() + 3600))  # readable and under cap again
            self.assertEqual(api.writes[-1], ("s1", False))
            self.assertNotIn("s1", hub.store.cap_state())

    def test_owner_pause_and_owner_resume_are_authoritative(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.registry(folder)
            hub, api = self.rig(folder, paused=True)  # "*" set outside the dashboard (no row)
            self.enforce(hub, path, api, (10, time.time() + 3600))  # under cap: Silo never lifts it
            self.enforce(hub, path, api, (95, time.time() + 3600))
            self.assertEqual(api.writes, [])
            self.assertNotIn("s1", hub.store.cap_state())
            api.config["claude"][0]["keys"][0]["excluded-models"] = []
            future = time.time() + 3600
            self.enforce(hub, path, api, (95, future))
            self.assertEqual(api.writes, [("s1", True)])  # Silo caps it
            self.owner(hub, path, api, False)  # ...and the owner resumes it from the dashboard
            self.assertEqual(hub.store.cap_state()["s1"]["label"], dashboard_server.OWNER_OVERRIDE)
            self.enforce(hub, path, api, (96, future), times=2)
            self.assertEqual(api.writes, [("s1", True), ("s1", False)])  # not silently re-capped
            self.enforce(hub, path, api, (20, future))  # under cap: the override ends, normal capping resumes
            self.assertNotIn("s1", hub.store.cap_state())
            self.owner(hub, path, api, True)  # the owner's dashboard pause is recorded as theirs
            self.assertEqual(hub.store.cap_state()["s1"]["label"], dashboard_server.OWNER_PAUSE)
            self.enforce(hub, path, api, (10, future), times=2)
            self.assertTrue(api.paused())  # ...never lifted by Silo
            self.owner(hub, path, api, False)
            self.assertNotIn("s1", hub.store.cap_state())  # owner's pause lifted: normal capping
            self.assertFalse(api.paused())

    def test_expired_owner_override_re_pauses_in_the_same_poll(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.registry(folder)
            hub, api = self.rig(folder)
            hub.store.set_cap_state("s1", time.time() - 1, dashboard_server.OWNER_OVERRIDE)  # override window over
            self.enforce(hub, path, api, (97, time.time() + 3600))
            self.assertEqual(api.writes, [("s1", True)])  # no 30 s window live past the cap
            self.assertTrue(hub.store.cap_state()["s1"]["label"].startswith("Capped until "))

    def test_resume_outside_the_dashboard_is_re_asserted(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.registry(folder)
            hub, api = self.rig(folder)
            future = time.time() + 3600
            self.enforce(hub, path, api, (95, future))
            api.config["claude"][0]["keys"][0]["excluded-models"] = []  # someone lifted "*" by hand
            self.enforce(hub, path, api, (95, future))
            self.assertEqual(api.writes, [("s1", True), ("s1", True)])
            self.assertTrue(hub.store.cap_state()["s1"]["label"].startswith("Capped until "))

    def test_enforce_failure_is_recorded_not_swallowed(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.registry(folder)
            hub, api = self.rig(folder)
            api.fail_put = 500
            self.enforce(hub, path, api, (95, time.time() + 3600))
            self.assertEqual(hub.remote_quotas["s1"]["error"], "Silo cap enforcement failed (HTTP 500).")
            self.assertNotIn("s1", hub.store.cap_state())  # the write failed, so no cap is recorded

    def test_snapshot_lists_silo_accounts_from_the_registry(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.registry(folder)
            hub, api = self.rig(folder)
            self.enforce(hub, path, api, (95, time.time() + 3600))
            with patch.object(dashboard_server, "SILO_REGISTRY", path):
                snap = hub.snapshot(24)
            self.assertEqual([a["name"] for a in snap["accounts"]], ["owner.json", "s1"])
            silo_acct = snap["accounts"][1]
            self.assertEqual((silo_acct["id"], silo_acct["silo"], silo_acct["nickname"], silo_acct["plan"], silo_acct["capped"], silo_acct["cap_percent"]),
                             ("silo:s1", True, "s1", "Claude Teams Slot 1", True, 85))
            self.assertEqual(len(silo_acct["windows"]), 1)
            self.assertAlmostEqual(silo_acct["windows"][0]["remaining"], 5.0, places=2)
            self.assertNotIn("cpakey", silo_acct)
            row = snap["silo"][0]
            self.assertEqual((row["id"], row["usage_percent"], row["capped"], row["cap_percent"]), ("silo:s1", 95, True, 85))
            self.assertNotIn("cpakey", row)
            # Verify plan mapping for Claude Teams, ChatGPT Business, and Google AI Ultra slots.
            self.assertEqual(dashboard_server.silo_plan("claude", "s2"), "Claude Teams Slot 2")
            self.assertEqual(dashboard_server.silo_plan("codex", "c1"), "ChatGPT Business Slot 1")
            self.assertEqual(dashboard_server.silo_plan("codex", "c4"), "ChatGPT Business Slot 4")
            self.assertEqual(dashboard_server.silo_plan("antigravity", "u1"), "Google AI Ultra")
            # A custom nickname still overrides the default slot name.
            hub.store.set_nickname("silo:s1", "Team Alpha")
            with patch.object(dashboard_server, "SILO_REGISTRY", path):
                snap2 = hub.snapshot(24)
            self.assertEqual(snap2["accounts"][1]["nickname"], "Team Alpha")

    def test_remote_quota_detail_parses_windows_and_records_history(self):
        import io
        class Reply:
            def __init__(self, body):
                self.body = body
            def __enter__(self):
                return io.BytesIO(json.dumps(self.body).encode())
            def __exit__(self, *a):
                return False
        payload = {
            "used_percent": 71, "reset_at": 1795492799, "provider": "claude",
            "windows": [
                {"id": "five_hour", "label": "5-hour limit", "remaining": 95, "reset_at": 1795240000, "period": 18000},
                {"id": "seven_day", "label": "Weekly limit", "remaining": 29, "reset_at": 1795492799, "period": 604800},
            ],
        }
        with tempfile.TemporaryDirectory() as folder:
            path = self.registry(folder)
            hub, api = self.rig(folder)
            with patch.object(dashboard_server, "SILO_REGISTRY", path), \
                    patch.object(hub, "request", side_effect=api), \
                    patch.object(dashboard_server.urllib.request, "urlopen", return_value=Reply(payload)):
                hub.enforce_caps()
                snap = hub.snapshot(24)
            silo_acct = next(a for a in snap["accounts"] if a["id"] == "silo:s1")
            self.assertEqual([(w["id"], w["remaining"]) for w in silo_acct["windows"]],
                             [("five_hour", 95.0), ("seven_day", 29.0)])
            hist_metrics = sorted({r["metric"] for r in snap["history"] if r["account"] == "silo:s1"})
            self.assertEqual(hist_metrics, ["five_hour", "seven_day"])

    def test_antigravity_silo_entry_pauses_via_openai_compatibility_disabled(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.registry(folder, seat="agy-gemini", provider="antigravity", hub_auth_name="a1")
            with patch.object(dashboard_server, "SILO_REGISTRY", path):
                reg = dashboard_server.load_registry()
            self.assertEqual([(e["hub_auth_name"], e["provider"], e["cap_percent"]) for e in reg],
                             [("a1", "antigravity", 90)])
            hub = Hub(Store(Path(folder) / "h.sqlite"))
            state = {"openai-compatibility": [{"name": "a1", "prefix": "a1", "base-url": "http://b/v1",
                                               "auth_index": "g-idx", "disabled": False,
                                               "models": [{"name": "gemini-4-neon-xhigh"}],
                                               "keys": [{"api-key": "A", "auth_index": "k-idx"}]}]}
            writes = []
            def fake_api(p, data=None, method=None, raw=False, if_match=None, etag=False):
                if p == "config/api-keys/openai-compatibility":
                    if method is None:
                        b = copy.deepcopy(state["openai-compatibility"])
                        return (b, '"v1"') if etag else b
                    if method == "PUT":
                        state["openai-compatibility"] = copy.deepcopy(data)
                        writes.append(bool(data[0].get("disabled")))
                        return {"status": "ok"}
                raise AssertionError(f"unexpected {method or 'GET'} {p}")
            future = time.time() + 3600
            with patch.object(dashboard_server, "SILO_REGISTRY", path), patch.object(hub, "request", side_effect=fake_api):
                with patch.object(Hub, "fetch_remote_quota", return_value=(92.0, future)):
                    hub.enforce_caps()
                self.assertEqual(writes, [True])
                self.assertTrue(state["openai-compatibility"][0]["disabled"])
                self.assertNotIn("auth_index", state["openai-compatibility"][0])
                self.assertNotIn("auth_index", state["openai-compatibility"][0]["keys"][0])
                hub.remote_quotas.pop("a1", None)
                with patch.object(Hub, "fetch_remote_quota", return_value=(20.0, future)):
                    hub.enforce_caps()
                self.assertEqual(writes, [True, False])
                self.assertFalse(state["openai-compatibility"][0]["disabled"])
                self.assertNotIn("a1", hub.store.cap_state())


class SiloGroupCapTests(unittest.TestCase):
    def setUp(self):
        folder = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.path = folder / "reg.json"
        self.registry()
        self.hub = Hub(Store(folder / "h.sqlite"))
        self.api = FakeHubAPI(groups=[{
            "name": "u1", "disabled": False, "auth_index": "view-group",
            "keys": [{"api-key": "CPAKEY", "auth_index": "view-key"}]}],
            family="openai-compatibility", account="u1")
        self.enterContext(patch.object(dashboard_server, "SILO_REGISTRY", self.path))
        self.enterContext(patch.object(self.hub, "request", side_effect=self.api))
        self.now = time.time()
        self.future = self.now + 3600

    def registry(self, **extra):
        self.path.write_text(json.dumps([silo_entry("u1", "antigravity", **{"cap_percent": 85, **extra})]))

    @property
    def config(self):
        return self.api.config[self.api.family][0]

    def enforce(self, *windows, error=None, fresh=True):
        reading = max(windows, key=lambda w: 100 - w["remaining"]) if windows else {}
        usage = (100 - reading["remaining"], reading["reset_at"], list(windows)) if reading else None
        if fresh and "u1" in self.hub.remote_quotas:
            self.hub.remote_quotas["u1"]["observed_at"] = 0
        with patch.object(dashboard_server.time, "time", return_value=self.now), \
                patch.object(self.hub, "_remote_fetch", side_effect=error, return_value=usage) as fetch:
            self.hub.enforce_caps()
        return fetch

    def owner(self, disabled):
        self.hub.owner_set_silo(dashboard_server.load_registry()[0], disabled)

    def test_quota_groups_choose_binding_windows_in_appearance_order(self):
        windows = [group_window("Gemini", 20, self.future, "gemini-5h"),
                   group_window("Claude & GPT", 90, self.future, "3p-weekly"),
                   group_window("Gemini", 40, self.future + 1, "gemini-weekly"),
                   group_window("Gemini", 40, self.future + 2, "gemini-tied"),
                   group_window("", 99, None), group_window(5, 100, None, "invalid")]
        self.assertEqual(dashboard_server.quota_groups(windows), [
            {"group": "Gemini", "used": 40, "reset_at": self.future + 1,
             "window_ids": ["gemini-5h", "gemini-weekly", "gemini-tied"]},
            {"group": "Claude & GPT", "used": 90, "reset_at": self.future, "window_ids": ["3p-weekly"]}])
        self.assertEqual(dashboard_server.quota_groups(windows[2:]), [])
        self.assertEqual(dashboard_server.quota_groups([{"id": "legacy"}]), [])

    def test_pattern_mapping_recognizes_groups_and_custom_names(self):
        patterns = silo_accounts.antigravity_group_patterns
        for name, ids, expected in [
            ("Claude & OpenAI", [], ["claude-*", "gpt-*"]), ("Other", [], ["claude-*", "gpt-*"]),
            ("Third party", [], ["claude-*", "gpt-*"]), ("Pool", ["3P-weekly"], ["claude-*", "gpt-*"]),
            ("Claude", [], ["claude-*"]), ("OpenAI", [], ["gpt-*"]), ("GPT", [], ["gpt-*"]),
            ("Imagen", [], ["*image*", "imagen-*"]), ("Gemini Image", [], ["*image*", "imagen-*"]),
            ("Gemini", [], ["gemini-*", "tab_*"]), ("Pool", ["Gemini:5h"], ["gemini-*", "tab_*"]),
            ("Experimental", [], None),
        ]:
            with self.subTest(group=name, windows=ids):
                self.assertEqual(patterns(name, ids), expected)
        self.assertEqual(patterns("Gemini", custom_models={"gemini": ["a*"], "Gemini": ["b*"]}), ["b*"])
        self.assertEqual(patterns("GEMINI", custom_models={"gemini": ["a*"]}), ["a*"])

    def test_registry_validates_group_settings_and_cap_precedence(self):
        self.registry(group_caps={"Gemini": 81.5, "Claude & GPT": 70, "Bool": True, "Low": 0, "High": 101, "Str": "85"},
                      group_models={"LABS": ["labs-*", "future-*"], "bad": "name", "empty": [],
                                    "blank": [""], "mixed": ["valid", 3]})
        entry = dashboard_server.load_registry()[0]
        self.assertEqual(entry["group_caps"], {"Gemini": 81.5, "Claude & GPT": 70})
        self.assertEqual(entry["group_models"], {"LABS": ["labs-*", "future-*"]})
        self.assertEqual(dashboard_server.silo_group_cap(entry, "Gemini", {}, {}), 81.5)
        self.hub.store.set_cap_override("u1", 90)
        self.hub.store.set_cap_group_override("u1", "Claude & GPT", 85)
        self.enforce(group_window("Gemini", 84, self.future), group_window("Claude & GPT", 88, self.future),
                     group_window("Labs", 92, self.future))
        self.assertEqual(self.config["excluded-models"], ["claude-*", "gpt-*", "labs-*", "future-*"])
        row = self.hub.snapshot(24)["silo"][0]
        self.assertEqual([(g["group"], g["cap_percent"]) for g in row["group_caps"]],
                         [("Gemini", 90), ("Claude & GPT", 85), ("Labs", 90)])

    def test_two_groups_cap_only_claude_and_gpt_and_keep_manual_exclusions(self):
        import io

        self.config["excluded-models"] = ["manual-*", "claude-opus-beta"]
        windows = [group_window("Gemini", 0, self.future, "gemini-5h"),
                   group_window("Gemini", 0, self.future, "gemini-weekly"),
                   group_window("Claude & GPT", 87.92, self.future, "3p-weekly")]
        reply = io.BytesIO(json.dumps({"used_percent": 87.92, "reset_at": self.future, "windows": windows}).encode())
        with patch.object(dashboard_server.time, "time", return_value=self.now), \
                patch.object(dashboard_server.urllib.request, "urlopen", return_value=reply):
            self.hub.enforce_caps()
        self.enforce(*windows, fresh=False).assert_not_called()
        self.assertEqual(self.api.writes, [("u1", False)])
        self.assertEqual(self.config["excluded-models"], ["manual-*", "claude-opus-beta", "claude-*", "gpt-*"])
        self.assertNotIn("auth_index", self.config)
        self.assertNotIn("auth_index", self.config["keys"][0])
        self.assertEqual(self.hub.store.cap_state(), {})
        snap = self.hub.snapshot(24)
        for row in (snap["accounts"][0], snap["silo"][0]):
            self.assertFalse(row["capped"])
            self.assertFalse(row["disabled"])
            self.assertEqual(row["group_caps"], [
                {"group": "Gemini", "usage_percent": 0, "cap_percent": 85, "window_caps": {"5h": 85, "weekly": 85},
                 "capped": False, "capped_until": None, "cap_label": None, "cap_reason": None, "owner": None},
                {"group": "Claude & GPT", "usage_percent": 87.92, "cap_percent": 85, "window_caps": {"5h": 85, "weekly": 85},
                 "capped": True, "capped_until": self.future, "cap_label": dashboard_server.cap_label(self.future),
                 "cap_reason": "87.9% used (85% cap)", "owner": None}])

        windows[-1] = group_window("Claude & GPT", 84, self.future, "3p-weekly")
        self.enforce(*windows)
        self.assertEqual(self.config["excluded-models"], ["manual-*", "claude-opus-beta"])
        self.assertEqual(self.hub.store.cap_group_state(), {})

    def test_three_groups_can_cap_one_two_or_all_and_resume_independently(self):
        pro = group_window("Gemini Pro", 85, self.future)
        flash = group_window("Gemini Flash", 90, self.future + 1)
        other = group_window("Claude & GPT", 92, self.future + 2)
        low = lambda w: {**w, "remaining": 90}
        pro_patterns = ["gemini-*-pro*", "gemini-4-*", "gemini-3-pro*", "gemini-2.5-pro*"]
        flash_patterns = ["gemini-*flash*", "tab_flash*", "tab_jump_flash*"]
        self.enforce(pro, low(flash), low(other))
        self.assertEqual(self.config["excluded-models"], pro_patterns)
        self.enforce(pro, flash, low(other))
        self.assertFalse(self.config["disabled"])
        self.assertEqual(self.config["excluded-models"], pro_patterns + flash_patterns)
        self.enforce(pro, flash, other)
        self.assertTrue(self.config["disabled"])
        self.assertNotIn("excluded-models", self.config)
        snap = self.hub.snapshot(24)
        for row in (snap["accounts"][0], snap["silo"][0]):
            self.assertTrue(row["capped"])
            self.assertTrue(row["disabled"])
            self.assertEqual(row["capped_until"], self.future + 2)
            self.assertEqual(row["cap_label"], dashboard_server.cap_label(self.future + 2))
        self.enforce(low(pro), flash, other)
        self.assertFalse(self.config["disabled"])
        self.assertEqual(self.config["excluded-models"], flash_patterns + ["claude-*", "gpt-*"])

    def test_legacy_cap_migrates_only_after_hub_accepts_the_group_write(self):
        self.config["disabled"] = True
        label = dashboard_server.cap_label(self.future)
        self.hub.store.set_cap_state("u1", self.future, label)
        windows = (group_window("Claude & GPT", 95, self.future), group_window("Gemini", 5, self.future))
        self.api.fail_put = 412
        self.enforce(*windows)
        self.assertTrue(self.config["disabled"])
        self.assertEqual(self.hub.store.cap_state(), {"u1": {"capped_until": self.future, "label": label}})
        self.assertEqual(self.hub.store.cap_group_state(), {})
        self.assertIn("HTTP 412", self.hub.remote_quotas["u1"]["error"])
        self.api.fail_put = None
        self.enforce(*windows)
        self.assertFalse(self.config["disabled"])
        self.assertEqual(self.config["excluded-models"], ["claude-*", "gpt-*"])
        self.assertEqual(self.hub.store.cap_state(), {})
        self.assertEqual(self.hub.store.cap_group_state(), {"u1": {"Claude & GPT": {
            "capped_until": self.future, "label": label, "reason": "95% used (85% cap)"}}})

    def test_unknown_capped_group_fails_closed_and_recovers(self):
        self.config["excluded-models"] = ["manual-*"]
        gemini = group_window("Gemini", 5, self.future)
        self.enforce(gemini, group_window("Labs", 98, self.future))
        self.assertTrue(self.config["disabled"])
        self.assertEqual(self.config["excluded-models"], ["manual-*"])
        self.enforce(gemini, group_window("Labs", 40, self.future))
        self.assertFalse(self.config["disabled"])
        self.assertEqual(self.hub.store.cap_group_state(), {})

    def test_one_groups_reset_requires_a_fresh_current_read_before_uncapping(self):
        reset = self.now + 1
        gemini = group_window("Gemini", 96, self.future)
        self.enforce(gemini, group_window("Claude & GPT", 90, reset))
        self.now += 2
        self.enforce(gemini, group_window("Claude & GPT", 10, reset), fresh=False).assert_called_once()
        self.assertTrue(self.config["disabled"])
        self.assertEqual(self.hub.store.cap_group_state()["u1"]["Claude & GPT"]["capped_until"],
                         self.now + dashboard_server.QUOTA_MIN_INTERVAL["antigravity"])
        self.enforce(gemini, group_window("Claude & GPT", 10, self.future))
        self.assertFalse(self.config["disabled"])
        self.assertEqual(self.config["excluded-models"], ["gemini-*", "tab_*"])

    def test_unreadable_groups_fail_closed_then_reconcile_on_recovery(self):
        windows = (group_window("Gemini", 5, self.future), group_window("Claude & GPT", 95, self.future))
        self.enforce(*windows)
        for _ in range(dashboard_server.SILO_UNREADABLE_POLLS - 1):
            self.enforce(error=ValueError("Laptop unreachable"))
            self.assertFalse(self.config["disabled"])
            self.assertEqual(self.config["excluded-models"], ["claude-*", "gpt-*"])
        self.enforce(error=ValueError("Laptop unreachable"))
        self.assertTrue(self.config["disabled"])
        self.assertNotIn("excluded-models", self.config)
        self.assertEqual(self.hub.store.cap_state()["u1"]["label"], dashboard_server.SILO_UNREADABLE)
        self.enforce(*windows)
        self.assertFalse(self.config["disabled"])
        self.assertEqual(self.config["excluded-models"], ["claude-*", "gpt-*"])
        self.assertEqual(self.hub.store.cap_state(), {})

    def test_external_pause_stays_in_place(self):
        self.config["disabled"] = True
        self.enforce(group_window("Gemini", 0, self.future), group_window("Claude & GPT", 90, self.future))
        self.assertTrue(self.config["disabled"])
        self.assertEqual(self.api.writes, [])
        self.assertEqual(self.hub.store.cap_group_state(), {})

    def test_owner_can_resume_partial_and_full_caps_until_the_last_reset_or_all_under_cap(self):
        gemini = group_window("Gemini", 90, self.future + 10)
        other = group_window("Claude & GPT", 95, self.future)
        gemini_low = {**gemini, "remaining": 90}
        other_low = {**other, "remaining": 90}
        self.config["excluded-models"] = ["manual-*"]
        self.enforce(gemini_low, other)
        self.owner(False)
        self.assertEqual(self.hub.store.cap_state()["u1"], {"label": dashboard_server.OWNER_OVERRIDE,
                                                           "capped_until": self.future})
        self.assertEqual(self.hub.store.cap_group_state(), {})
        self.enforce(gemini, other_low)
        self.assertEqual(self.config["excluded-models"], ["manual-*"])
        self.assertEqual(self.hub.snapshot(24)["silo"][0]["group_caps"][0]["owner"], dashboard_server.OWNER_OVERRIDE)
        self.enforce(gemini_low, other_low)
        self.assertEqual(self.hub.store.cap_state(), {})
        self.enforce(gemini, other)
        self.assertTrue(self.config["disabled"])
        self.owner(False)
        self.assertFalse(self.config["disabled"])
        self.assertEqual(self.hub.store.cap_state()["u1"]["capped_until"], self.future + 10)
        self.now = self.future + 10
        self.enforce(gemini, other)
        self.assertTrue(self.config["disabled"])
        self.assertEqual(self.hub.store.cap_state(), {})

    def test_owner_pause_clears_patterns_and_is_authoritative(self):
        gemini = group_window("Gemini", 10, self.future)
        other = group_window("Claude & GPT", 95, self.future)
        self.enforce(gemini, other)
        self.owner(True)
        self.assertTrue(self.config["disabled"])
        self.assertNotIn("excluded-models", self.config)
        self.assertEqual(self.hub.store.cap_state()["u1"]["label"], dashboard_server.OWNER_PAUSE)
        self.enforce(gemini, group_window("Claude & GPT", 10, self.future))
        self.assertTrue(self.config["disabled"])
        self.owner(False)
        self.assertFalse(self.config["disabled"])
        self.assertEqual(self.hub.store.cap_state(), {})
        self.assertEqual(self.hub.store.cap_group_state(), {})
        self.enforce(gemini, other)
        self.assertEqual(self.config["excluded-models"], ["claude-*", "gpt-*"])

    def test_snapshot_includes_saved_groups_without_quota_windows(self):
        self.hub.store.set_cap_group_override("u1", "Gemini", 77)
        self.hub.store.set_cap_group_state("u1", "Claude & GPT", self.future, "saved")
        row = self.hub.snapshot(24)["silo"][0]
        self.assertFalse(row["capped"])
        self.assertEqual([(g["group"], g["cap_percent"], g["usage_percent"], g["capped"]) for g in row["group_caps"]],
                         [("Claude & GPT", 85, None, True), ("Gemini", 77, None, False)])


class ActivityIndicatorTests(unittest.TestCase):
    def test_read_files_tracks_request_deltas_and_inference_verified_timestamps(self):
        with tempfile.TemporaryDirectory() as folder:
            hub = Hub(Store(Path(folder) / "h.sqlite"))
            now = time.time()
            recent_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - 30))
            old_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - 600))
            initial = [
                {"auth_index": "a", "name": "claude-a.json", "provider": "claude", "success": 10, "failed": 0,
                 "last_inference_verified_at": recent_iso},
                {"auth_index": "b", "name": "claude-b.json", "provider": "claude", "success": 5, "failed": 1,
                 "last_inference_verified_at": old_iso},
            ]
            with patch.object(hub, "request", return_value={"files": initial}):
                hub.read_files()
            snap1 = {a["id"]: a for a in hub.snapshot(24)["accounts"]}
            self.assertTrue(snap1["a"]["in_use"])
            self.assertFalse(snap1["b"]["in_use"])
            self.assertIsNotNone(snap1["a"]["last_used_at"])
            self.assertIsNotNone(snap1["b"]["last_used_at"])

            # A new request on b bumps its counter -> marks b in_use even before last_inference_verified_at moves.
            updated = [initial[0], {**initial[1], "success": 6}]
            with patch.object(hub, "request", return_value={"files": updated}):
                hub.read_files()
            snap2 = {a["id"]: a for a in hub.snapshot(24)["accounts"]}
            self.assertTrue(snap2["b"]["in_use"])
            self.assertGreaterEqual(snap2["b"]["last_used_at"], now - 5)

    def test_read_activity_tracks_strategy_and_silo_api_key_deltas_without_leaking_secrets(self):
        with tempfile.TemporaryDirectory() as folder:
            reg_path = Path(folder) / "reg.json"
            reg_path.write_text(json.dumps([
                silo_entry("s1", "claude", silo_cpa_base="http://127.0.0.1:8321", cpakey="SECRET_S1"),
                silo_entry("u1", "antigravity", silo_cpa_base="http://127.0.0.1:8321", cpakey="SECRET_U1"),
            ]))
            hub = Hub(Store(Path(folder) / "h.sqlite"))
            hub.files = [{"auth_index": "p1", "name": "agy-personal.json", "provider": "antigravity"}]
            usage_state = {
                "claude": {"http://127.0.0.1:8321/acct/s1|SECRET_S1": {"success": 3, "failed": 0}},
                "u1": {"http://127.0.0.1:8321/acct/u1|SECRET_U1": {"success": 1, "failed": 0}},
            }

            def fake_req(path, *a, **kw):
                if path == "config/routing/strategy":
                    return "soonest-reset"
                if path == "observability/usage/api-keys":
                    return copy.deepcopy(usage_state)
                raise AssertionError(f"unexpected {path}")

            with patch.object(dashboard_server, "SILO_REGISTRY", reg_path), \
                    patch.object(hub, "request", side_effect=fake_req):
                hub.read_activity()  # baseline counts
                usage_state["claude"]["http://127.0.0.1:8321/acct/s1|SECRET_S1"]["success"] = 4
                hub.read_activity()  # delta on s1

            now = time.time()
            router_health = (
                {"u1": {"active_node": "mickeyd", "in_flight": 1, "last_used_at": now - 2, "nodes": []}},
                {"primary_in_flight": 0, "primary_last_used_at": now - 20},
            )
            with patch.object(dashboard_server, "SILO_REGISTRY", reg_path), \
                    patch.object(hub, "_router_health", return_value=router_health):
                snap = hub.snapshot(24)

            self.assertEqual(snap["routing_strategy"], "soonest-reset")
            by_id = {a["id"]: a for a in snap["accounts"]}
            self.assertTrue(by_id["silo:s1"]["in_use"])
            self.assertEqual(by_id["silo:s1"]["in_flight"], 0)
            self.assertTrue(by_id["silo:u1"]["in_use"])
            self.assertEqual(by_id["silo:u1"]["in_flight"], 1)
            # Single personal Antigravity OAuth account receives agy_native primary activity.
            self.assertTrue(by_id["p1"]["in_use"])
            self.assertAlmostEqual(by_id["p1"]["last_used_at"], now - 20, delta=1)
            raw_json = json.dumps(snap)
            self.assertNotIn("SECRET_S1", raw_json)
            self.assertNotIn("SECRET_U1", raw_json)

    def test_pick_next_up_honors_strategy_priority_and_availability(self):
        now = 1_700_000_000.0
        week = 7 * 86400
        accounts = [
            {"id": "c1", "name": "claude-1.json", "provider": "claude", "disabled": False, "unavailable": False,
             "requires_sign_in": False, "quota_at": now, "detail": {"priority": 0},
             "windows": [{"id": "seven_day", "period": week, "remaining": 80, "reset_at": now + 5 * 86400}]},
            {"id": "c2", "name": "claude-2.json", "provider": "claude", "disabled": False, "unavailable": False,
             "requires_sign_in": False, "quota_at": now, "detail": {"priority": 0},
             "windows": [{"id": "seven_day", "period": week, "remaining": 50, "reset_at": now + 2 * 86400}]},
            {"id": "c3", "name": "claude-3.json", "provider": "claude", "disabled": False, "unavailable": False,
             "requires_sign_in": False, "quota_at": now, "detail": {"priority": 0},
             "windows": [{"id": "seven_day", "period": week, "remaining": 0, "reset_at": now + 86400}]},
            {"id": "solo", "name": "codex-1.json", "provider": "codex", "disabled": False, "unavailable": False,
             "requires_sign_in": False, "quota_at": now, "detail": {"priority": 0}, "windows": []},
        ]
        # soonest-reset skips exhausted c3 and picks c2 (resets in 2d < 5d), ignores lone codex account.
        self.assertEqual(dashboard_server.pick_next_up_ids(accounts, "soonest-reset", now), {"c2"})
        # fill-first picks lexicographically first eligible (c1).
        self.assertEqual(dashboard_server.pick_next_up_ids(accounts, "fill-first", now), {"c1"})
        # round-robin has no deterministic single next account.
        self.assertEqual(dashboard_server.pick_next_up_ids(accounts, "round-robin", now), set())
        # Higher priority wins over sooner reset.
        accounts[0]["detail"]["priority"] = 1
        self.assertEqual(dashboard_server.pick_next_up_ids(accounts, "soonest-reset", now), {"c1"})


class CapacityWeightTests(unittest.TestCase):
    def test_default_plan_weights_cover_all_providers_and_tiers(self):
        w = dashboard_server.default_plan_weight
        self.assertEqual(w("claude", "Pro"), 1.0)
        self.assertEqual(w("claude", "Max 5x"), 6.0)
        self.assertEqual(w("claude", "Max 20x"), 8.2)
        self.assertEqual(w("claude", "Claude Ultra"), 8.2)
        self.assertEqual(w("claude", "Team · Standard"), 1.25)
        self.assertEqual(w("claude", "Claude Teams Slot 1"), 4.14)
        self.assertEqual(w("claude", "Team · Premium"), 4.14)
        self.assertEqual(w("claude", "Team · Premium", {"rate_limit_tier": "default_claude_max_20x"}), 8.2)
        self.assertEqual(w("claude", "Free"), 0.25)
        self.assertEqual(w("codex", "plus"), 1.0)
        self.assertEqual(w("codex", "prolite"), 10.0)
        self.assertEqual(w("codex", "pro"), 20.94)
        self.assertEqual(w("codex", "Pro 500"), 50.0)
        self.assertEqual(w("codex", "Business · Premium"), 5.0)
        self.assertEqual(w("codex", "go"), 0.5)
        self.assertEqual(w("codex", "free"), 0.25)
        self.assertEqual(w("codex", "ChatGPT Business Slot 2"), 1.0)
        self.assertEqual(w("antigravity", "Antigravity"), 1.0)
        self.assertEqual(w("antigravity", "Google AI Ultra"), 5.0)
        self.assertEqual(w("antigravity", "Google AI Ultra 20x"), 20.0)
        self.assertEqual(w("xai", "SuperGrok"), 1.0)
        self.assertEqual(w("xai", "X Plus"), 0.25)
        self.assertEqual(w("xai", "SuperGrok Lite"), 0.29)
        self.assertEqual(w("xai", "X Super"), 3.75)
        self.assertEqual(w("xai", "SuperGrok Plus"), 4.0)
        self.assertEqual(w("xai", "SuperGrok Heavy"), 10.0)
        self.assertEqual(w("xai", "X Ultra"), 12.5)
        self.assertEqual(w("devin", "Pro"), 1.0)
        self.assertEqual(w("devin", "Max"), 4.43)
        # Live mypriors plan_weights override built-in fallback ratios cleanly.
        self.assertEqual(w("devin", "Max", plan_weights={"devin": {"max": 5.5}}), 5.5)
        self.assertEqual(w("claude", "Claude Ultra", plan_weights={"claude": {"ultra": 9.1}}), 9.1)

    def test_weighted_pool_series_and_stack_track_units_and_active_weights(self):
        rows = [
            {"ts": 100, "account": "pro1", "metric": "five_hour", "remaining": 80},
            {"ts": 100, "account": "max1", "metric": "five_hour", "remaining": 100},
            {"ts": 400, "account": "pro1", "metric": "five_hour", "remaining": 20},
            {"ts": 400, "account": "max1", "metric": "five_hour", "remaining": 100},
        ]
        pts = dashboard_server.pool_series(rows, ["pro1", "max1"], "five_hour", 900, weights={"pro1": 1.0, "max1": 5.0})
        self.assertEqual([(p["ts"], p["value"], p["units"], p["weight"]) for p in pts], [
            (100, 180, 5.8, 6.0),
            (400, 120, 5.2, 6.0),
        ])
        codex_pts = [{"ts": 100, "value": 50, "units": 0.5, "weight": 1.0},
                     {"ts": 400, "value": 50, "units": 0.5, "weight": 1.0}]
        stacked = dashboard_server.pool_stack({"claude": pts, "codex": codex_pts}, 900)
        self.assertEqual(len(stacked), 2)
        self.assertAlmostEqual(stacked[1]["units"], 5.7, places=4)
        self.assertAlmostEqual(stacked[1]["parts_pct"]["claude"], 5.2 / 6.0 * 100, places=2)
        self.assertAlmostEqual(stacked[1]["parts_pct"]["codex"], 50.0, places=2)
        self.assertAlmostEqual(stacked[1]["weighted"], (5.2 / 6.0 * 100 + 50.0) / 2, places=2)

    def test_weight_override_endpoint_validates_persists_and_clears(self):
        with tempfile.TemporaryDirectory() as folder:
            reg_path = Path(folder) / "reg.json"
            reg_path.write_text(json.dumps([
                {"seat": "s1", "provider": "claude", "node": "n1",
                 "silo_cpa_base": "http://127.0.0.1:1", "cpakey": "k", "hub_auth_name": "s1", "weight": 1.5}
            ]))
            hub = Hub(Store(Path(folder) / "test.sqlite"))
            hub.management_key = lambda: "test-key"
            hub.files = [
                {"auth_index": "c1", "name": "claude-pro.json", "provider": "claude", "disabled": False},
                {"auth_index": "c2", "name": "claude-max.json", "provider": "claude", "disabled": False},
            ]
            hub.quotas["c1"] = {"plan": "Pro", "windows": [], "observed_at": time.time()}
            hub.quotas["c2"] = {"plan": "Max 5x", "windows": [], "observed_at": time.time()}
            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            server.hub = hub
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                def req(path, body=None, cookie=None):
                    conn = http.client.HTTPConnection("127.0.0.1", server.server_port)
                    headers = {"Host": "localhost:8318", "X-Dashboard-Request": "1", "Content-Type": "application/json"}
                    if cookie:
                        headers["Cookie"] = cookie
                    conn.request("GET" if body is None else "POST", "/dashboard/api/" + path,
                                 body=json.dumps(body) if body is not None else None, headers=headers)
                    res = conn.getresponse()
                    out = res.status, json.loads(res.read()), res.getheader("Set-Cookie")
                    conn.close()
                    return out

                # Auth required
                self.assertEqual(req("account/weight", {"id": "c1", "weight": 2})[0], 401)
                cookie = req("login", {"key": "test-key"})[2].split(";")[0]

                with patch.object(dashboard_server, "SILO_REGISTRY", reg_path), \
                        patch.object(hub, "_router_health", return_value=({}, {})):
                    # Initial snapshot carries detected plan_weight and registry weight.
                    by_id = {a["id"]: a for a in req("snapshot", cookie=cookie)[1]["accounts"]}
                    self.assertEqual((by_id["c1"]["plan_weight"], by_id["c1"]["weight"], by_id["c1"]["weight_override"]), (1.0, 1.0, None))
                    self.assertEqual((by_id["c2"]["plan_weight"], by_id["c2"]["weight"], by_id["c2"]["weight_override"]), (6.0, 6.0, None))
                    self.assertEqual((by_id["silo:s1"]["plan_weight"], by_id["silo:s1"]["weight"]), (1.5, 1.5))

                    # Reject bad values and unknown accounts.
                    for bad in (0, -1, 1001, True, "abc"):
                        self.assertEqual(req("account/weight", {"id": "c1", "weight": bad}, cookie)[0], 400)
                    self.assertEqual(req("account/weight", {"id": "missing", "weight": 2}, cookie)[0], 404)

                    # Set custom override on both hub and Silo accounts.
                    self.assertEqual(req("account/weight", {"id": "c2", "weight": 12.5}, cookie)[:2], (200, {"weight": 12.5}))
                    self.assertEqual(req("account/weight", {"id": "silo:s1", "weight": 2}, cookie)[:2], (200, {"weight": 2.0}))
                    by_id = {a["id"]: a for a in req("snapshot", cookie=cookie)[1]["accounts"]}
                    self.assertEqual((by_id["c2"]["plan_weight"], by_id["c2"]["weight_override"], by_id["c2"]["weight"]), (6.0, 12.5, 12.5))
                    self.assertEqual((by_id["silo:s1"]["plan_weight"], by_id["silo:s1"]["weight_override"], by_id["silo:s1"]["weight"]), (1.5, 2.0, 2.0))

                    # Clear override back to Auto.
                    self.assertEqual(req("account/weight", {"id": "c2", "weight": None}, cookie)[:2], (200, {"weight": None}))
                    by_id = {a["id"]: a for a in req("snapshot", cookie=cookie)[1]["accounts"]}
                    self.assertEqual((by_id["c2"]["weight_override"], by_id["c2"]["weight"]), (None, 6.0))

                    # Plan override endpoint validates, updates plan + derived plan_weight, and clears back to Auto.
                    self.assertEqual(req("account/plan", {"id": "c1", "plan": "Max 20x"})[0], 401)
                    self.assertEqual(req("account/plan", {"id": "missing", "plan": "Max 20x"}, cookie)[0], 404)
                    self.assertEqual(req("account/plan", {"id": "c1", "plan": 123}, cookie)[0], 400)
                    self.assertEqual(req("account/plan", {"id": "c1", "plan": "x" * 49}, cookie)[0], 400)
                    self.assertEqual(req("account/plan", {"id": "c1", "plan": "Max 20x"}, cookie)[:2], (200, {"plan": "Max 20x"}))
                    self.assertEqual(req("account/plan", {"id": "silo:s1", "plan": "Team · Standard"}, cookie)[:2],
                                     (200, {"plan": "Team · Standard"}))
                    by_id = {a["id"]: a for a in req("snapshot", cookie=cookie)[1]["accounts"]}
                    self.assertEqual((by_id["c1"]["plan"], by_id["c1"]["detected_plan"], by_id["c1"]["plan_override"], by_id["c1"]["plan_weight"], by_id["c1"]["weight"]),
                                     ("Max 20x", "Pro", "Max 20x", 8.2, 8.2))
                    # silo:s1 still has weight_override=2.0 from above, while plan_weight updates to 1.25.
                    self.assertEqual((by_id["silo:s1"]["plan"], by_id["silo:s1"]["plan_override"], by_id["silo:s1"]["plan_weight"], by_id["silo:s1"]["weight"]),
                                     ("Team · Standard", "Team · Standard", 1.25, 2.0))
                    # Clear plan overrides back to Auto.
                    self.assertEqual(req("account/plan", {"id": "c1", "plan": ""}, cookie)[:2], (200, {"plan": None}))
                    self.assertEqual(req("account/plan", {"id": "silo:s1", "plan": None}, cookie)[:2], (200, {"plan": None}))
                    by_id = {a["id"]: a for a in req("snapshot", cookie=cookie)[1]["accounts"]}
                    self.assertEqual((by_id["c1"]["plan"], by_id["c1"]["plan_override"], by_id["c1"]["plan_weight"]), ("Pro", None, 1.0))
                    self.assertEqual((by_id["silo:s1"]["plan"], by_id["silo:s1"]["plan_override"], by_id["silo:s1"]["plan_weight"]), ("Claude Teams Slot 1", None, 1.5))
            finally:
                server.shutdown()
                server.server_close()
                thread.join()

    def test_silo_activity_snapshots_and_hourly_attribution_in_snapshot(self):
        with tempfile.TemporaryDirectory() as folder:
            reg_path = Path(folder) / "silo.json"
            reg_path.write_text(json.dumps([
                silo_entry("s1", "claude", silo_cpa_base="http://127.0.0.1:8321", cpakey="SECRET_S1"),
                silo_entry("s2", "claude", silo_cpa_base="http://127.0.0.1:8321", cpakey="SECRET_S2"),
            ]))
            store = Store(Path(folder) / "h.sqlite")
            hub = Hub(store)
            usage_state = {
                "claude": {"http://127.0.0.1:8321/acct/s1|SECRET_S1": {"success": 5, "failed": 0}},
            }

            def fake_req(path, *a, **kw):
                if path == "config/routing/strategy":
                    return "fill-first"
                if path == "observability/usage/api-keys":
                    return copy.deepcopy(usage_state)
                raise AssertionError(f"unexpected {path}")

            now = time.time()
            hour = int(now // 3600) * 3600
            store.save_live_buckets([{
                "key_id": "shared", "hour": hour, "provider": "claude",
                "account": "silo:s1", "model": "claude-opus-4-6",
                "requests": 4, "failed": 0, "input_tokens": 100, "output_tokens": 50,
                "cache_read_tokens": 0, "cache_write_tokens": 0, "tokens": 150,
            }])
            with patch.object(dashboard_server, "SILO_REGISTRY", reg_path), \
                    patch.object(hub, "request", side_effect=fake_req), \
                    patch.object(hub, "fetch_remote_quota", return_value=(30.0, now + 3600)):
                hub.read_activity()
                reg = dashboard_server.load_registry()
                hub.remote_usage(reg[0], now - 300)
                hub.remote_usage(reg[1], now - 300)

            with patch.object(dashboard_server, "SILO_REGISTRY", reg_path), \
                    patch.object(hub, "_router_health", return_value=({}, {})):
                snap = hub.snapshot(24)

            act = snap["silo_activity"]
            self.assertEqual(act["silo:s1"]["samples"][-1][1], 5)
            # s2 was absent from api-keys usage when the endpoint answered -> recorded as 0 requests.
            self.assertEqual(act["silo:s2"]["samples"][-1][1], 0)
            self.assertEqual(act["silo:s1"]["hourly"][str(hour)], 4)
            self.assertEqual(act["silo:s2"]["hourly"], {})
            self.assertEqual(act["silo:s2"]["hourly_range"], [hour, hour + 3600])


class ApiCalibrationTests(unittest.TestCase):
    def test_model_rates_match_tokens_page_rates_and_cache_accounting(self):
        # Verify server MODEL_RATES mirrors TOK_MODEL_RATES in the Tokens page script.
        js = (Path(__file__).parent / "assets" / "app-tokens.js").read_text(encoding="utf-8")
        m = re.search(r"const TOK_MODEL_RATES = \[(.*?)\n\];", js, re.S)
        self.assertIsNotNone(m)
        js_rates = re.findall(
            r"\[/([^/]+)/,\s*\{\s*in:\s*([0-9.]+),\s*out:\s*([0-9.]+),\s*read:\s*([0-9.]+),\s*write:\s*([0-9.]+)\s*\}\]",
            m.group(1),
        )
        self.assertEqual(len(js_rates), len(api_pricing.MODEL_RATES))
        for (js_pat, j_in, j_out, j_read, j_write), (py_rx, py_rate) in zip(js_rates, api_pricing.MODEL_RATES):
            self.assertEqual(py_rx.pattern, js_pat)
            self.assertEqual(list(py_rate), [float(j_in), float(j_out), float(j_read), float(j_write)])

        # Claude reports cache_read separately from input_tokens; OpenAI/Gemini include cache_read in input_tokens.
        claude_cost = api_pricing.bucket_api_cost("claude", "claude-opus-4-6", 1_000_000, 0, 500_000, 0)
        self.assertAlmostEqual(claude_cost, 5.0 + 0.25, places=6)
        codex_cost = api_pricing.bucket_api_cost("codex", "gpt-5.4", 1_000_000, 0, 500_000, 0)
        self.assertAlmostEqual(codex_cost, 1.25 + 0.125, places=6)
        neon_cost = api_pricing.bucket_api_cost("antigravity", "gemini-4-neon-high", 1_000_000, 0, 500_000, 0)
        self.assertAlmostEqual(neon_cost, 1.50 + 0.15, places=6)
        self.assertIsNone(api_pricing.bucket_api_cost("codex", "unknown-custom-model", 1000, 1000, 0, 0))

    def test_api_calibration_excludes_silo_shrinks_small_samples_and_splits_agy_groups(self):
        with tempfile.TemporaryDirectory() as folder:
            store = Store(Path(folder) / "cal.sqlite")
            now = int(time.time() // 3600) * 3600
            # Personal Claude Max 5x account burns 20% of its 5h window (= 100% of a 1x window)
            # over 2 hours while spending $60 in Opus API-equivalent tokens -> observed = $60 / 1x.
            # With prior $45 and K=25%, Empirical Bayes = (25*45 + 100*60) / 125 = $57.00 / 1x.
            store.save("c1", "claude", {"plan": "Max 5x", "observed_at": now + 600, "windows": [
                {"id": "five_hour", "label": "5-hour limit", "remaining": 90.0, "reset_at": now + 18000, "period": 18000},
            ]})
            store.save("c1", "claude", {"plan": "Max 5x", "observed_at": now + 1800, "windows": [
                {"id": "five_hour", "label": "5-hour limit", "remaining": 80.0, "reset_at": now + 18000, "period": 18000},
            ]})
            store.save("c1", "claude", {"plan": "Max 5x", "observed_at": now + 4200, "windows": [
                {"id": "five_hour", "label": "5-hour limit", "remaining": 80.0, "reset_at": now + 18000, "period": 18000},
            ]})
            store.save("c1", "claude", {"plan": "Max 5x", "observed_at": now + 5400, "windows": [
                {"id": "five_hour", "label": "5-hour limit", "remaining": 70.0, "reset_at": now + 18000, "period": 18000},
            ]})
            # Shared Silo account with huge external drop and $0 hub cost MUST be excluded from calibration.
            store.save("silo:s1", "claude", {"plan": "Claude Teams Slot 1", "observed_at": now + 600, "windows": [
                {"id": "five_hour", "label": "5-hour limit", "remaining": 90.0, "reset_at": now + 18000, "period": 18000},
            ]})
            store.save("silo:s1", "claude", {"plan": "Claude Teams Slot 1", "observed_at": now + 1800, "windows": [
                {"id": "five_hour", "label": "5-hour limit", "remaining": 10.0, "reset_at": now + 18000, "period": 18000},
            ]})
            # Devin tiny 1% drop with $0.10 cost (would imply $10 vs $80 prior) stays close to prior via shrinkage.
            store.save("d1", "devin", {"plan": "Pro", "observed_at": now + 600, "windows": [
                {"id": "weekly", "label": "Weekly limit", "remaining": 100.0, "reset_at": now + 604800, "period": 604800},
            ]})
            store.save("d1", "devin", {"plan": "Pro", "observed_at": now + 1800, "windows": [
                {"id": "weekly", "label": "Weekly limit", "remaining": 99.0, "reset_at": now + 604800, "period": 604800},
            ]})
            # Antigravity separate Gemini vs 3p groups: Gemini drops 50% on $5 Gemini cost ($10/1x),
            # 3p drops 50% on $10 Claude cost ($20/1x).
            store.save("a1", "antigravity", {"plan": "Antigravity", "observed_at": now + 600, "windows": [
                {"id": "gemini:5h", "group": "Gemini", "label": "Gemini · 5h", "remaining": 100.0, "reset_at": now + 18000, "period": 18000},
                {"id": "claude:5h", "group": "Claude & GPT", "label": "Claude & GPT · 5h", "remaining": 100.0, "reset_at": now + 18000, "period": 18000},
            ]})
            store.save("a1", "antigravity", {"plan": "Antigravity", "observed_at": now + 1800, "windows": [
                {"id": "gemini:5h", "group": "Gemini", "label": "Gemini · 5h", "remaining": 50.0, "reset_at": now + 18000, "period": 18000},
                {"id": "claude:5h", "group": "Claude & GPT", "label": "Claude & GPT · 5h", "remaining": 50.0, "reset_at": now + 18000, "period": 18000},
            ]})
            store.save_live_buckets([
                # $30 in hour 0 + $30 in hour 1 on c1 (claude-opus-4-6: $5/M input -> 6M input = $30)
                {"key_id": "k", "hour": now, "provider": "claude", "account": "claude-max.json",
                 "model": "claude-opus-4-6", "requests": 10, "failed": 0, "input_tokens": 6_000_000,
                 "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0, "tokens": 6_000_000},
                {"key_id": "k", "hour": now + 3600, "provider": "claude", "account": "claude-max.json",
                 "model": "claude-opus-4-6", "requests": 10, "failed": 0, "input_tokens": 6_000_000,
                 "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0, "tokens": 6_000_000},
                # $0.10 on Devin (claude-opus-4-6: 20k input = $0.10)
                {"key_id": "k", "hour": now, "provider": "devin", "account": "devin-1.json",
                 "model": "claude-opus-4-6", "requests": 1, "failed": 0, "input_tokens": 20_000,
                 "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0, "tokens": 20_000},
                # $5 Gemini + $10 Claude on Antigravity a1
                {"key_id": "k", "hour": now, "provider": "antigravity", "account": "agy-1.json",
                 "model": "gemini-3-pro", "requests": 5, "failed": 0, "input_tokens": 2_500_000,
                 "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0, "tokens": 2_500_000},
                {"key_id": "k", "hour": now, "provider": "antigravity", "account": "agy-1.json",
                 "model": "claude-opus-4-6", "requests": 5, "failed": 0, "input_tokens": 2_000_000,
                 "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0, "tokens": 2_000_000},
            ])
            accounts = [
                {"id": "c1", "name": "claude-max.json", "provider": "claude", "weight": 5.0, "silo": False},
                {"id": "silo:s1", "name": "s1", "provider": "claude", "weight": 5.0, "silo": True},
                {"id": "d1", "name": "devin-1.json", "provider": "devin", "weight": 1.0, "silo": False},
                {"id": "a1", "name": "agy-1.json", "provider": "antigravity", "weight": 1.0, "silo": False},
            ]
            cal = store.api_calibration(accounts)
            # Claude 5h: prior=50, obs=60 over 100% 1x-drop -> (25*50 + 100*60)/125 = 58.0, calibrated.
            self.assertAlmostEqual(cal[("claude", "5h")]["usd_per_1x"], 58.0, places=2)
            self.assertEqual(cal[("claude", "5h")]["source"], "calibrated")
            self.assertEqual(cal[("claude", "5h")]["obs_hours"], 2)
            # Devin 7d: prior=29, obs=10 over 1% 1x-drop -> (25*29 + 1*10)/26 = 28.27, blended.
            self.assertAlmostEqual(cal[("devin", "7d")]["usd_per_1x"], 28.27, places=2)
            self.assertEqual(cal[("devin", "7d")]["source"], "blended")
            # Antigravity groups calibrated independently:
            # Gemini: prior=25, obs=10 over 50% -> (25*25 + 50*10)/75 = 15.0
            # 3p:     prior=25, obs=20 over 50% -> (25*25 + 50*20)/75 = 21.67
            self.assertAlmostEqual(cal[("antigravity", "5h", "gemini")]["usd_per_1x"], 15.0, places=2)
            self.assertAlmostEqual(cal[("antigravity", "5h", "3p")]["usd_per_1x"], 21.67, places=2)

    def test_pool_series_and_snapshot_attach_calibrated_api_usd(self):
        rows = [
            {"ts": 100, "account": "c1", "metric": "five_hour", "remaining": 50.0},
            {"ts": 100, "account": "c2", "metric": "five_hour", "remaining": 100.0},
        ]
        claude_pts = dashboard_server.pool_series(
            rows, ["c1", "c2"], "five_hour", 900,
            weights={"c1": 1.0, "c2": 5.0}, usd_per_1x=50.0,
        )
        # units = 0.5 + 5.0 = 5.5x -> usd = 5.5 * 50 = 275.0, usd_cap = 6.0 * 50 = 300.0
        self.assertEqual(claude_pts[0]["usd"], 275.0)
        self.assertEqual(claude_pts[0]["usd_cap"], 300.0)
        agy_pts = [{"ts": 100, "value": 100.0, "units": 5.0, "weight": 5.0, "usd": 40.0, "usd_cap": 40.0}]
        stacked = dashboard_server.pool_stack({"claude": claude_pts, "antigravity": agy_pts}, 900)
        self.assertEqual(stacked[0]["usd"], 315.0)
        self.assertEqual(stacked[0]["usd_cap"], 340.0)
        self.assertEqual(stacked[0]["parts_usd"], {"claude": 275.0, "antigravity": 40.0})

        with tempfile.TemporaryDirectory() as folder:
            reg_path = Path(folder) / "reg.json"
            reg_path.write_text(json.dumps([
                silo_entry("s1", "claude", weight=5.0),
            ]))
            hub = Hub(Store(Path(folder) / "snap.sqlite"))
            now = time.time()
            hub.files = [
                {"auth_index": "c1", "name": "claude-pro.json", "provider": "claude", "disabled": False},
            ]
            hub.quotas["c1"] = {"plan": "Pro", "observed_at": now, "windows": [
                {"id": "five_hour", "label": "5-hour limit", "remaining": 80.0, "reset_at": now + 3600, "period": 18000},
            ]}
            hub.quotas["silo:s1"] = {"plan": "Claude Teams Slot 1", "observed_at": now, "windows": [
                {"id": "five_hour", "label": "5-hour limit", "remaining": 60.0, "reset_at": now + 3600, "period": 18000},
            ]}
            with patch.object(dashboard_server, "SILO_REGISTRY", reg_path), \
                    patch.object(hub, "_router_health", return_value=({}, {})):
                snap = hub.snapshot(24)
            by_id = {a["id"]: a for a in snap["accounts"]}
            # Prior claude 5h = 50 CU / 1x -> Pro (1x) = 50, Silo Teams (5x registry weight) = 250.
            self.assertEqual(by_id["c1"]["windows"][0]["api_usd"], 50.0)
            self.assertEqual(by_id["c1"]["windows"][0]["api_usd_source"], "estimate")
            self.assertEqual(by_id["silo:s1"]["windows"][0]["api_usd"], 250.0)
            self.assertIn("claude", snap["api_calibration"])
            self.assertEqual(snap["api_calibration"]["claude"]["5h"]["usd_per_1x"], 50.0)

    def test_mypriors_subsidies_parser_and_daily_hub_sync(self):
        sample_payload = {
            "sellers": [
                {
                    "id": "anthropic",
                    "plans": [
                        {"plan": "Claude Pro", "feeUsd": 20, "median": 80.0, "models": [
                            {"id": "claude-opus-5.5", "multiple": 64.0},
                            {"id": "claude-sonnet-5.5", "multiple": 64.0},
                        ]},
                        {"plan": "Claude Ultra", "feeUsd": 200, "median": 60.0, "models": [
                            {"id": "claude-opus-5.5", "multiple": 64.0},
                            {"id": "claude-sonnet-5.5", "multiple": 64.0},
                            {"id": "claude-fable-5", "multiple": 8.0},
                        ]},
                        {"plan": "Claude Max 5x", "feeUsd": 100, "median": 60.0, "models": [
                            {"id": "claude-opus-5.5", "multiple": 76.8},
                        ]},
                        {"plan": "Claude Team Premium", "feeUsd": 125, "median": 42.0, "models": [
                            {"id": "claude-opus-5.5", "multiple": 42.0},
                        ]},
                    ],
                },
                {
                    "id": "devin",
                    "plans": [
                        {"plan": "Devin Pro", "feeUsd": 20, "median": 6.0, "models": [{"id": "claude-opus-5.5", "multiple": 6.0}]},
                        {"plan": "Devin Max", "feeUsd": 200, "median": 3.0, "models": [{"id": "claude-opus-5.5", "multiple": 3.0}]},
                    ],
                },
                {
                    "id": "xai",
                    "plans": [
                        {"plan": "X Premium", "feeUsd": 30, "median": 10.0, "models": [{"id": "grok-4.7", "multiple": 10.0}]},
                        {"plan": "X Ultra", "feeUsd": 200, "median": 18.0, "models": [{"id": "grok-4.7", "multiple": 18.0}]},
                    ],
                },
            ],
        }
        escaped = json.dumps(json.dumps(sample_payload))[1:-1]
        html = f'<html><script>self.__next_f.push([1,"prefix:{escaped}suffix"])</script></html>'
        parsed = api_pricing.parse_mypriors_subsidies(html, fetched_at=1700000000.0)
        # Shared-model median ignores fable-5 (not on Pro) so Ultra = (200*64)/(20*64) = 10.0x, Max 5x = 6.0x.
        self.assertEqual(parsed["plan_weights"]["claude"]["ultra"], 10.0)
        self.assertEqual(parsed["plan_weights"]["claude"]["max_5x"], 6.0)
        self.assertEqual(parsed["plan_weights"]["devin"]["max"], 5.0)
        self.assertEqual(parsed["plan_weights"]["xai"]["ultra"], 12.0)
        self.assertAlmostEqual(parsed["priors_7d"]["devin"], round(120.0 / (30.4375 / 7.0), 2), places=2)
        self.assertAlmostEqual(parsed["priors_7d"]["xai"], round(300.0 / (30.4375 / 7.0), 2), places=2)

        # Hub.sync_mypriors_subsidies persists to SQLite, updates snapshot weights/priors, and respects 24h TTL.
        with tempfile.TemporaryDirectory() as folder:
            store = Store(Path(folder) / "mp.sqlite")
            hub = Hub(store)
            now = time.time()
            hub.files = [
                {"auth_index": "d1", "name": "devin-max.json", "provider": "devin", "disabled": False},
            ]
            hub.quotas["d1"] = {"plan": "Max", "observed_at": now, "windows": [
                {"id": "weekly", "label": "Weekly limit", "remaining": 50.0, "reset_at": now + 86400, "period": 7 * 86400},
            ]}
            fresh = {**parsed, "fetched_at": now}
            with patch.object(dashboard_server, "fetch_mypriors_subsidies", return_value=fresh) as fetcher:
                hub.sync_mypriors_subsidies()
                hub.sync_mypriors_subsidies()  # second call skipped within 24h TTL
                self.assertEqual(fetcher.call_count, 1)
            self.assertEqual(store.mypriors_subsidies()["priors_7d"]["devin"], parsed["priors_7d"]["devin"])
            with patch.object(hub, "_router_health", return_value=({}, {})):
                snap = hub.snapshot(24)
            devin_acct = snap["accounts"][0]
            self.assertEqual(devin_acct["plan_weight"], 5.0)
            self.assertAlmostEqual(devin_acct["windows"][0]["api_usd"], round(parsed["priors_7d"]["devin"] * 5.0, 2), places=2)
            self.assertEqual(snap["api_calibration"]["devin"]["7d"]["prior_source"], "mypriors")
            self.assertEqual(snap["mypriors_synced_at"], now)

            # A second Hub on the same SQLite loads cached mypriors immediately without fetching again.
            hub2 = Hub(Store(Path(folder) / "mp.sqlite"))
            with patch.object(dashboard_server, "fetch_mypriors_subsidies") as fetcher2:
                hub2.sync_mypriors_subsidies()
                fetcher2.assert_not_called()


class ManagementUsageShimTests(unittest.TestCase):
    def _start_server(self, folder, registry_entries, proxy_v0_fn):
        reg_path = Path(folder) / "reg.json"
        reg_path.write_text(json.dumps(registry_entries))
        cred_path = Path(folder) / "credentials.json"
        cred_path.write_text(json.dumps({"management_key": "secret-mgmt-key"}))
        hub = Hub(Store(Path(folder) / "shim.sqlite"))
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.hub = hub
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        stack = contextlib.ExitStack()
        stack.callback(server.server_close)
        stack.callback(server.shutdown)
        stack.enter_context(patch.object(dashboard_server, "SILO_REGISTRY", reg_path))
        stack.enter_context(patch.object(dashboard_server, "CREDENTIALS", cred_path))
        stack.enter_context(patch.object(dashboard_server, "LOCAL_HOSTS", {f"127.0.0.1:{port}", f"localhost:{port}"}))
        stack.enter_context(patch.object(hub, "proxy_v0", side_effect=proxy_v0_fn))
        return stack, hub, port

    def _req(self, port, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            hdrs = dict(headers or {})
            payload = None
            if body is not None:
                payload = json.dumps(body).encode()
                hdrs.setdefault("Content-Type", "application/json")
            conn.request(method, path, body=payload, headers=hdrs)
            resp = conn.getresponse()
            raw = resp.read()
            if resp.getheader("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
            return resp.status, json.loads(raw.decode())
        finally:
            conn.close()

    def test_shim_requires_bearer_management_key(self):
        with tempfile.TemporaryDirectory() as folder:
            stack, _, port = self._start_server(folder, [], lambda *a, **kw: (200, "application/json", b'{"files":[]}'))
            with stack:
                status, _ = self._req(port, "GET", "/v0/management/auth-files")
                self.assertEqual(status, 401)
                status, _ = self._req(port, "GET", "/v0/management/auth-files", headers={"Authorization": "Bearer wrong"})
                self.assertEqual(status, 401)
                status, _ = self._req(port, "POST", "/v0/management/api-call", body={"auth_index": "silo:s1"})
                self.assertEqual(status, 401)
                # Tailscale Funnel must still be refused.
                status, _ = self._req(port, "GET", "/v0/management/auth-files",
                                      headers={"Authorization": "Bearer secret-mgmt-key", "Tailscale-Funnel-Request": "1"})
                self.assertEqual(status, 403)

    def test_auth_files_appends_idlenet_seats_and_applies_nicknames(self):
        with tempfile.TemporaryDirectory() as folder:
            entries = [
                silo_entry("s1", "claude"),
                silo_entry("c1", "codex"),
                silo_entry("u1", "antigravity"),
            ]
            upstream = {"files": [
                {"id": "claude-personal.json", "name": "claude-personal.json", "auth_index": "abc",
                 "provider": "claude", "email": "me@example.com", "disabled": False},
                {"id": "claude-unnamed.json", "name": "claude-unnamed.json", "auth_index": "def",
                 "provider": "claude", "email": "other@example.com", "disabled": False},
            ]}
            calls = []

            def fake_proxy(path, data=None, method=None):
                calls.append((path, method))
                return 200, "application/json", json.dumps(upstream).encode()

            stack, hub, port = self._start_server(folder, entries, fake_proxy)
            with stack:
                hub.store.set_nickname("claude-personal.json", "MAX 1")
                hub.store.set_nickname("silo:s1", "Teams 1")
                auth = {"Authorization": "Bearer secret-mgmt-key"}
                status, data = self._req(port, "GET", "/v0/management/auth-files", headers=auth)
                self.assertEqual(status, 200)
                by_auth = {f["auth_index"]: f for f in data["files"]}
                self.assertEqual(set(by_auth), {"abc", "def", "silo:s1", "silo:c1", "silo:u1"})
                # Nicknamed personal account exposes nickname as id and omits email so T3 shows MAX 1.
                self.assertEqual(by_auth["abc"]["id"], "MAX 1")
                self.assertNotIn("email", by_auth["abc"])
                # Un-nicknamed personal account keeps original id and email.
                self.assertEqual(by_auth["def"]["id"], "claude-unnamed.json")
                self.assertEqual(by_auth["def"]["email"], "other@example.com")
                # Idlenet seats expose their display name as id and omit email so T3 shows Teams 1 / c1 / u1.
                self.assertEqual(by_auth["silo:s1"]["id"], "Teams 1")
                self.assertNotIn("email", by_auth["silo:s1"])
                self.assertFalse(by_auth["silo:s1"]["disabled"])
                self.assertEqual(by_auth["silo:c1"]["id"], "c1")
                self.assertNotIn("email", by_auth["silo:c1"])
                self.assertEqual(by_auth["silo:c1"]["id_token"], {"plan_type": "business"})
                self.assertEqual(by_auth["silo:u1"]["id"], "u1")
                self.assertNotIn("email", by_auth["silo:u1"])
                self.assertEqual(by_auth["silo:u1"]["project_id"], "silo:u1")

                # Filtered auth-files requests pass straight through without modifying or appending seats.
                status, filtered = self._req(port, "GET", "/v0/management/auth-files?name=claude-personal.json", headers=auth)
                self.assertEqual(status, 200)
                self.assertEqual([f["id"] for f in filtered["files"]], ["claude-personal.json", "claude-unnamed.json"])

                # auth-files/models returns 404 for silo ids (raw or displayed) and maps nicknamed personal ids back.
                for silo_name in ("silo:s1", "Teams%201", "c1", "u1"):
                    status, _ = self._req(port, "GET", f"/v0/management/auth-files/models?name={silo_name}", headers=auth)
                    self.assertEqual(status, 404, silo_name)
                status, _ = self._req(port, "GET", "/v0/management/auth-files/models?name=MAX%201", headers=auth)
                self.assertEqual(status, 200)
                self.assertIn(("auth-files/models?name=claude-personal.json", None), calls)

    def test_api_call_synthesizes_claude_codex_antigravity_and_relays_personal(self):
        with tempfile.TemporaryDirectory() as folder:
            entries = [
                silo_entry("s1", "claude"),
                silo_entry("c1", "codex"),
                silo_entry("u1", "antigravity"),
            ]
            relayed = []

            def fake_proxy(path, data=None, method=None):
                relayed.append((path, method, json.loads(data.decode()) if data else None))
                return 200, "application/json", json.dumps({"status_code": 200, "body": '{"ok":true}'}).encode()

            stack, hub, port = self._start_server(folder, entries, fake_proxy)
            with stack:
                hub.quotas["silo:s1"] = {"plan": "Claude Teams Slot 1", "windows": [
                    {"id": "five_hour", "label": "5-hour limit", "remaining": 70.0, "reset_at": None, "period": 18000},
                    {"id": "seven_day", "label": "Weekly limit", "remaining": 2.0, "reset_at": 1795492800, "period": 604800},
                    {"id": "weekly_scoped:fable_5", "label": "Weekly · Fable 5", "remaining": 60.0,
                     "reset_at": 1795492800, "period": 604800},
                ]}
                hub.quotas["silo:c1"] = {"plan": "ChatGPT Business Slot 1", "windows": [
                    {"id": "rate_limit:5h", "label": "5-hour limit", "remaining": 100.0, "reset_at": 1795491702, "period": 18000},
                    {"id": "rate_limit:7d", "label": "Weekly limit", "remaining": 56.0, "reset_at": 1795634204, "period": 604800},
                ]}
                hub.quotas["silo:u1"] = {"plan": "Google AI Ultra", "windows": [
                    {"id": "gemini-5h", "label": "Gemini · 5-hour limit", "group": "Gemini",
                     "remaining": 100.0, "reset_at": 1795491704, "period": 18000},
                    {"id": "3p-weekly", "label": "Claude & GPT · Weekly limit", "group": "Claude & GPT",
                     "remaining": 12.08, "reset_at": 1795484720, "period": 604800},
                ]}
                auth = {"Authorization": "Bearer secret-mgmt-key"}

                # Claude usage probe
                st, res = self._req(port, "POST", "/v0/management/api-call", headers=auth, body={
                    "auth_index": "silo:s1", "method": "GET", "url": "https://api.anthropic.com/api/oauth/usage",
                })
                self.assertEqual((st, res["status_code"]), (200, 200))
                claude_body = json.loads(res["body"])
                self.assertEqual(claude_body["five_hour"], {"utilization": 30.0, "resets_at": None})
                self.assertEqual(claude_body["seven_day"]["utilization"], 98.0)
                self.assertTrue(claude_body["seven_day"]["resets_at"].endswith("Z"))
                self.assertEqual(claude_body["limits"][0]["scope"]["model"]["display_name"], "Fable 5")

                # Codex usage + reset credits probes
                st, res = self._req(port, "POST", "/v0/management/api-call", headers=auth, body={
                    "auth_index": "silo:c1", "method": "GET", "url": "https://chatgpt.com/backend-api/wham/usage",
                })
                self.assertEqual((st, res["status_code"]), (200, 200))
                codex_body = json.loads(res["body"])
                self.assertEqual(codex_body["plan_type"], "business")
                self.assertEqual(codex_body["rate_limit"]["primary_window"],
                                 {"used_percent": 0.0, "reset_at": 1795491702, "limit_window_seconds": 18000})
                self.assertEqual(codex_body["rate_limit"]["secondary_window"],
                                 {"used_percent": 44.0, "reset_at": 1795634204, "limit_window_seconds": 604800})
                st, res = self._req(port, "POST", "/v0/management/api-call", headers=auth, body={
                    "auth_index": "silo:c1", "method": "GET",
                    "url": "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
                })
                self.assertEqual((st, res["status_code"]), (200, 404))
                st, res = self._req(port, "POST", "/v0/management/api-call", headers=auth, body={
                    "auth_index": "silo:c1", "method": "POST",
                    "url": "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
                })
                self.assertEqual((st, res["status_code"]), (200, 400))

                # Antigravity summary + userinfo probes
                st, res = self._req(port, "POST", "/v0/management/api-call", headers=auth, body={
                    "auth_index": "silo:u1", "method": "POST",
                    "url": "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
                    "data": '{"project":"silo:u1"}',
                })
                self.assertEqual((st, res["status_code"]), (200, 200))
                agy_body = json.loads(res["body"])
                groups = {g["displayName"]: g["buckets"] for g in agy_body["groups"]}
                self.assertEqual(groups["Gemini"][0]["bucketId"], "gemini-5h")
                self.assertEqual(groups["Gemini"][0]["window"], "5h")
                self.assertEqual(groups["Gemini"][0]["remainingFraction"], 1.0)
                self.assertAlmostEqual(groups["Claude & GPT"][0]["remainingFraction"], 0.1208, places=4)
                st, res = self._req(port, "POST", "/v0/management/api-call", headers=auth, body={
                    "auth_index": "silo:u1", "method": "GET",
                    "url": "https://www.googleapis.com/oauth2/v2/userinfo",
                })
                self.assertEqual((st, res["status_code"]), (200, 404))

                # Non-silo account relays untouched to CLIProxyAPI
                st, res = self._req(port, "POST", "/v0/management/api-call", headers=auth, body={
                    "auth_index": "abc", "method": "GET", "url": "https://api.anthropic.com/api/oauth/usage",
                })
                self.assertEqual((st, res["status_code"]), (200, 200))
                self.assertEqual(len(relayed), 1)
                self.assertEqual(relayed[0][2]["auth_index"], "abc")

                # Unknown silo seat -> 404
                st, _ = self._req(port, "POST", "/v0/management/api-call", headers=auth, body={
                    "auth_index": "silo:missing", "method": "GET", "url": "https://api.anthropic.com/api/oauth/usage",
                })
                self.assertEqual(st, 404)


class SiloTimedPriorityTests(unittest.TestCase):
    def test_effective_silo_priority_respects_inclusive_local_date(self):
        from datetime import datetime
        entry = {"priority": 1, "priority_until": "2026-12-31"}
        end_of_year = datetime(2026, 12, 31, 23, 59, 59).astimezone().timestamp()
        new_year = datetime(2027, 1, 1, 0, 0, 0).astimezone().timestamp()
        self.assertEqual(dashboard_server.effective_silo_priority(entry, end_of_year), 1)
        self.assertEqual(dashboard_server.effective_silo_priority(entry, new_year), 0)
        self.assertEqual(dashboard_server.effective_silo_priority({"priority": 1}, new_year), 1)
        self.assertEqual(dashboard_server.effective_silo_priority({"priority": 1, "priority_until": "bad"}, end_of_year), 0)
        with tempfile.TemporaryDirectory() as folder:
            reg = Path(folder) / "reg.json"
            reg.write_text(json.dumps([{
                "seat": "c1", "provider": "codex", "node": "ash",
                "silo_cpa_base": "http://127.0.0.1:8321", "cpakey": "k",
                "hub_auth_name": "c1", "cap_percent": 90,
                "priority": 1, "priority_until": "2026-12-31",
            }]), encoding="utf-8")
            parsed = dashboard_server.parse_registry(reg)
            self.assertEqual(parsed[0]["priority"], 1)
            self.assertEqual(parsed[0]["priority_until"], "2026-12-31")

    def test_enforce_cap_syncs_and_expires_silo_priority(self):
        from datetime import datetime
        with tempfile.TemporaryDirectory() as folder:
            store = dashboard_server.Store(Path(folder) / "q.sqlite")
            hub = dashboard_server.Hub(store)
            groups = [{"name": "c1", "prefix": "c1", "base-url": "http://127.0.0.1:8321/acct/c1/v1",
                       "keys": [{"api-key": "k1", "websockets": True, "default-service-tier": "priority"}]}]
            puts = []

            def fake_request(path, data=None, method=None, raw=False, if_match=None, etag=False):
                if path == "config/api-keys/codex" and method is None:
                    body = json.loads(json.dumps(groups))
                    return (body, '"etag-1"') if etag else body
                if path == "config/api-keys/codex" and method == "PUT":
                    puts.append(json.loads(json.dumps(data)))
                    groups[:] = json.loads(json.dumps(data))
                    return {"status": "ok"}
                raise AssertionError(f"unexpected {method} {path}")

            hub.request = fake_request
            hub.fetch_remote_quota = lambda e: (20.0, None)
            entry = {**silo_entry("c1", "codex"), "cap_percent": 90, "priority": 1, "priority_until": "2026-12-31"}

            before = datetime(2026, 12, 31, 23, 0, 0).astimezone().timestamp()
            hub.enforce_cap(entry, {}, before)
            self.assertEqual(len(puts), 1)
            self.assertEqual(groups[0]["priority"], 1)
            self.assertEqual(groups[0]["keys"][0]["default-service-tier"], "priority")

            # Steady state before expiry performs no redundant PUT.
            hub.enforce_cap(entry, {}, before + 10)
            self.assertEqual(len(puts), 1)

            # After Dec 31, priority automatically reverts to 0 (removed from group).
            after = datetime(2027, 1, 1, 0, 0, 1).astimezone().timestamp()
            hub.enforce_cap(entry, {}, after)
            self.assertEqual(len(puts), 2)
            self.assertNotIn("priority", groups[0])

    def test_pick_next_up_prefers_higher_priority_silo_codex_seat(self):
        now = 1_795_500_000
        accounts = [
            {"id": "personal-1", "name": "codex-a.json", "provider": "codex", "silo": False,
             "disabled": False, "unavailable": False, "requires_sign_in": False, "capped": False,
             "detail": {"priority": 0},
             "windows": [{"id": "rate_limit:7d", "remaining": 80, "reset_at": now + 3600, "period": 7 * 86400}]},
            {"id": "silo:c1", "name": "c1", "provider": "codex", "silo": True,
             "disabled": False, "unavailable": False, "requires_sign_in": False, "capped": False,
             "detail": {"priority": 1},
             "windows": [{"id": "rate_limit:7d", "remaining": 90, "reset_at": now + 7200, "period": 7 * 86400}]},
        ]
        self.assertEqual(dashboard_server.pick_next_up_ids(accounts, "soonest-reset", now), {"silo:c1"})
        accounts[1]["detail"] = {}
        self.assertEqual(dashboard_server.pick_next_up_ids(accounts, "soonest-reset", now), {"personal-1"})


class IdlenetHatchingAndCapFormatTests(unittest.TestCase):
    def test_cap_label_uses_readable_datetime_and_cap_reason_names_triggering_window(self):
        from datetime import datetime
        ts = datetime(2026, 11, 24, 19, 0, 0).timestamp()
        self.assertEqual(dashboard_server.cap_label(ts), "Capped until Nov 24, 7:00 PM")
        self.assertEqual(dashboard_server.cap_label(None), "Capped")

        windows = [
            {"id": "rate_limit:5h", "label": "5-hour limit", "remaining": 12.0, "reset_at": ts, "period": 5 * 3600},
            {"id": "rate_limit:7d", "label": "Weekly limit", "remaining": 41.0, "reset_at": ts + 86400, "period": 7 * 86400},
        ]
        self.assertEqual(dashboard_server.cap_reason(windows, 85), "5-hour limit at 88% (85% cap)")
        self.assertEqual(
            dashboard_server.cap_reason(windows, 50),
            "5-hour limit at 88%, Weekly limit at 59% (50% cap)",
        )
        self.assertEqual(
            dashboard_server.cap_reason(windows, 85, unreadable=True, error="Laptop unreachable."),
            "Quota unreadable (Laptop unreachable)",
        )
        self.assertEqual(
            dashboard_server.cap_reason(
                [{"id": "g:5h", "label": "Claude & GPT · 5-hour limit", "group": "Claude & GPT", "remaining": 10.0}],
                85,
                group="Claude & GPT",
            ),
            "5-hour limit at 90% (85% cap)",
        )

    def test_pool_series_and_stack_track_idlenet_share_across_units(self):
        rows = [
            {"ts": 1000, "account": "p1", "metric": "rate_limit:7d", "remaining": 80.0},
            {"ts": 1000, "account": "silo:c1", "metric": "rate_limit:7d", "remaining": 60.0},
            {"ts": 1300, "account": "p1", "metric": "rate_limit:7d", "remaining": 70.0},
            {"ts": 1300, "account": "silo:c1", "metric": "rate_limit:7d", "remaining": 50.0},
        ]
        codex_pts = dashboard_server.pool_series(
            rows, ["p1", "silo:c1"], "rate_limit:7d", 900,
            weights={"p1": 1.0, "silo:c1": 2.0}, usd_per_1x=100.0, silo_ids={"silo:c1"},
        )
        self.assertEqual(len(codex_pts), 2)
        self.assertAlmostEqual(codex_pts[0]["value"], 140.0)
        self.assertAlmostEqual(codex_pts[0]["silo_value"], 60.0)
        self.assertAlmostEqual(codex_pts[0]["units"], 2.0)
        self.assertAlmostEqual(codex_pts[0]["silo_units"], 1.2)
        self.assertAlmostEqual(codex_pts[0]["usd"], 200.0)
        self.assertAlmostEqual(codex_pts[0]["silo_usd"], 120.0)

        claude_rows = [
            {"ts": 1000, "account": "cl1", "metric": "seven_day", "remaining": 90.0},
            {"ts": 1300, "account": "cl1", "metric": "seven_day", "remaining": 85.0},
        ]
        claude_pts = dashboard_server.pool_series(
            claude_rows, ["cl1"], "seven_day", 900,
            weights={"cl1": 1.0}, usd_per_1x=100.0,
        )
        self.assertNotIn("silo_value", claude_pts[0])
        stacked = dashboard_server.pool_stack({"codex": codex_pts, "claude": claude_pts}, 900, backfill=True)
        self.assertEqual(stacked[0]["silo_parts"], {"codex": 60.0})
        self.assertAlmostEqual(stacked[0]["silo_parts_units"]["codex"], 1.2)
        self.assertAlmostEqual(stacked[0]["silo_parts_usd"]["codex"], 120.0)
        self.assertAlmostEqual(stacked[0]["silo_parts_pct"]["codex"], 40.0)

    def test_store_migrates_legacy_cap_tables_without_reason_column(self):
        with tempfile.TemporaryDirectory() as folder:
            db_path = Path(folder) / "legacy.sqlite"
            import sqlite3
            conn = sqlite3.connect(db_path)
            try:
                with conn:
                    conn.execute("CREATE TABLE cap_state (account TEXT PRIMARY KEY, capped_until REAL, label TEXT NOT NULL)")
                    conn.execute("CREATE TABLE cap_group_state (account TEXT NOT NULL, grp TEXT NOT NULL, capped_until REAL, label TEXT NOT NULL, PRIMARY KEY(account, grp))")
                    conn.execute("INSERT INTO cap_state VALUES ('c1', 1795568400, 'Capped by Silo until 2026-11-24 19:00')")
            finally:
                conn.close()
            store = Store(db_path)
            self.assertEqual(store.cap_state()["c1"]["capped_until"], 1795568400)
            store.set_cap_state("c1", 1795568400, "Capped until Nov 24, 7:00 PM", reason="5-hour limit at 88% (85% cap)")
            self.assertEqual(store.cap_state()["c1"]["reason"], "5-hour limit at 88% (85% cap)")



