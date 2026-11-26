import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from claude_routing import (
    PROBE_HOLD_SECONDS,
    WEEK_SECONDS,
    decide_claude_route,
    is_agy_claude_window,
    is_agy_routable_model,
)

NOW = 1_800_000_000.0


def claude_acct(aid, reset_in=None, remaining=80.0, five_h_rem=90.0, silo=False,
                cap_percent=85.0, capped=False, disabled=False, unavailable=False):
    return {
        "id": aid,
        "provider": "claude",
        "name": aid,
        "disabled": disabled,
        "unavailable": unavailable,
        "requires_sign_in": False,
        "capped": capped,
        "cap_percent": cap_percent if silo else None,
        "silo": silo,
        "quota_at": NOW - 30,
        "quota_error": None,
        "cooldown_until": None,
        "windows": [
            {"id": "five_hour", "label": "5-hour limit", "remaining": five_h_rem,
             "reset_at": NOW + 3600, "period": 5 * 3600},
            {"id": "seven_day", "label": "Weekly limit", "remaining": remaining,
             "reset_at": (NOW + reset_in) if reset_in is not None else None, "period": WEEK_SECONDS},
        ],
    }


def agy_acct(aid, name=None, silo=False, w_rem=100.0, w_reset_in=None, h_rem=100.0, h_reset_in=None,
             disabled=False, unavailable=False, capped=False, group_caps=None, cap_percent=None):
    return {
        "id": aid,
        "provider": "antigravity",
        "name": name or aid,
        "disabled": disabled,
        "unavailable": unavailable,
        "requires_sign_in": False,
        "capped": capped,
        "cap_percent": cap_percent,
        "group_caps": group_caps or [],
        "silo": silo,
        "quota_at": NOW - 30,
        "quota_error": None,
        "cooldown_until": None,
        "windows": [
            {"id": "gemini-5h", "label": "Gemini · 5-hour limit", "group": "Gemini",
             "remaining": 40.0, "reset_at": NOW + 1800, "period": 5 * 3600},
            {"id": "gemini-weekly", "label": "Gemini · Weekly limit", "group": "Gemini",
             "remaining": 50.0, "reset_at": NOW + 3600, "period": WEEK_SECONDS},
            {"id": "3p-5h", "label": "Claude & GPT · 5-hour limit", "group": "Claude & GPT",
             "remaining": h_rem, "reset_at": (NOW + h_reset_in) if h_reset_in is not None else None,
             "period": 5 * 3600},
            {"id": "3p-weekly", "label": "Claude & GPT · Weekly limit", "group": "Claude & GPT",
             "remaining": w_rem, "reset_at": (NOW + w_reset_in) if w_reset_in is not None else None,
             "period": WEEK_SECONDS},
        ],
    }


class TestClaudeRouting(unittest.TestCase):
    def test_model_gating(self):
        self.assertTrue(is_agy_routable_model("claude-opus-5-5"))
        self.assertTrue(is_agy_routable_model("Claude-Opus-5-5"))
        self.assertFalse(is_agy_routable_model("claude-sonnet-5-5"))
        self.assertFalse(is_agy_routable_model("claude-fable-5-2"))
        self.assertFalse(is_agy_routable_model("claude-haiku-5-5"))
        self.assertFalse(is_agy_routable_model("claude-opus-4-8"))

        accounts = [claude_acct("c1", reset_in=86400), agy_acct("a1", w_rem=100.0, w_reset_in=None)]
        res = decide_claude_route(accounts, now=NOW, model="claude-sonnet-5-5")
        self.assertEqual(res["target"], "claude")
        self.assertEqual(res["reason"], "model_not_agy_routable")

    def test_window_classifier_excludes_gemini(self):
        self.assertFalse(is_agy_claude_window({"id": "gemini-weekly", "group": "Gemini", "label": "Gemini · Weekly"}))
        self.assertTrue(is_agy_claude_window({"id": "3p-weekly", "group": "Claude & GPT", "label": "Claude & GPT · Weekly"}))

    def test_policy_a_starts_untouched_agy_and_respects_probe_hold(self):
        accounts = [
            claude_acct("c1", reset_in=36 * 3600),
            agy_acct("p1", silo=False, w_rem=100.0, w_reset_in=None),
            agy_acct("silo:u1", name="u1", silo=True, w_rem=100.0, w_reset_in=None, cap_percent=85.0),
        ]
        probes = {}
        # Peek without claim does not consume probe.
        peek = decide_claude_route(accounts, now=NOW, probes=probes, claim=False)
        self.assertEqual(peek["target"], "antigravity")
        self.assertEqual(peek["agy_account"], "primary")
        self.assertEqual(peek["reason"], "agy_window_unstarted")
        self.assertEqual(probes, {})

        # Claim 1 starts primary.
        first = decide_claude_route(accounts, now=NOW, probes=probes, claim=True)
        self.assertEqual(first["target"], "antigravity")
        self.assertEqual(first["agy_account"], "primary")
        self.assertEqual(first["reason"], "agy_window_unstarted")

        # Claim 2 immediately after starts u1 while primary is on probe hold.
        second = decide_claude_route(accounts, now=NOW + 10, probes=probes, claim=True)
        self.assertEqual(second["target"], "antigravity")
        self.assertEqual(second["agy_account"], "u1")
        self.assertEqual(second["reason"], "agy_window_unstarted")

        # Claim 3 while both are on probe hold falls back to Claude pool (no stampede).
        third = decide_claude_route(accounts, now=NOW + 20, probes=probes, claim=True)
        self.assertEqual(third["target"], "claude")
        self.assertEqual(third["reason"], "agy_probe_pending")

        # After probe hold expires, untouched primary is eligible again.
        fourth = decide_claude_route(accounts, now=NOW + PROBE_HOLD_SECONDS + 1, probes=probes, claim=False)
        self.assertEqual(fourth["target"], "antigravity")
        self.assertEqual(fourth["agy_account"], "primary")

    def test_rolling_7d_100pct_counts_as_unstarted(self):
        accounts = [
            claude_acct("c1", reset_in=36 * 3600),
            agy_acct("p1", silo=False, w_rem=100.0, w_reset_in=WEEK_SECONDS),
        ]
        res = decide_claude_route(accounts, now=NOW)
        self.assertEqual(res["target"], "antigravity")
        self.assertEqual(res["reason"], "agy_window_unstarted")
        self.assertTrue(res["agy_unstarted"])

    def test_active_agy_sooner_than_claude_wins(self):
        accounts = [
            claude_acct("c1", reset_in=48 * 3600),
            agy_acct("p1", silo=False, w_rem=60.0, w_reset_in=72 * 3600),
            agy_acct("silo:u1", name="u1", silo=True, w_rem=40.0, w_reset_in=12 * 3600,
                     group_caps=[{"group": "Claude & GPT", "cap_percent": 85.0, "capped": False}]),
        ]
        res = decide_claude_route(accounts, now=NOW)
        self.assertEqual(res["target"], "antigravity")
        self.assertEqual(res["agy_account"], "u1")
        self.assertEqual(res["agy_order"], ["u1", "primary"])
        self.assertEqual(res["reason"], "agy_soonest_reset")

    def test_claude_sooner_than_active_agy_wins(self):
        accounts = [
            claude_acct("c1", reset_in=12 * 3600),
            agy_acct("p1", silo=False, w_rem=80.0, w_reset_in=5 * 86400),
            agy_acct("silo:u1", name="u1", silo=True, w_rem=70.0, w_reset_in=3 * 86400,
                     group_caps=[{"group": "Claude & GPT", "cap_percent": 85.0, "capped": False}]),
        ]
        res = decide_claude_route(accounts, now=NOW)
        self.assertEqual(res["target"], "claude")
        self.assertEqual(res["reason"], "claude_soonest_reset")
        self.assertEqual(res["agy_account"], "u1")
        self.assertEqual(res["agy_order"], ["u1", "primary"])

    def test_u1_3p_cap_blocks_u1_but_gemini_cap_does_not(self):
        # u1 capped on Claude & GPT -> skipped even though it resets soonest.
        accounts_blocked = [
            claude_acct("c1", reset_in=48 * 3600),
            agy_acct("silo:u1", name="u1", silo=True, w_rem=12.0, w_reset_in=6 * 3600,
                     group_caps=[{"group": "Claude & GPT", "cap_percent": 85.0, "capped": True}]),
            agy_acct("p1", silo=False, w_rem=80.0, w_reset_in=72 * 3600),
        ]
        res = decide_claude_route(accounts_blocked, now=NOW)
        self.assertEqual(res["target"], "claude")
        self.assertEqual(res["agy_order"], ["primary"])

        # u1 capped ONLY on Gemini -> 3p is still allowed and wins.
        accounts_gemini_only = [
            claude_acct("c1", reset_in=48 * 3600),
            agy_acct("silo:u1", name="u1", silo=True, w_rem=50.0, w_reset_in=6 * 3600,
                     group_caps=[
                         {"group": "Gemini", "cap_percent": 85.0, "capped": True},
                         {"group": "Claude & GPT", "cap_percent": 85.0, "capped": False},
                     ]),
        ]
        res2 = decide_claude_route(accounts_gemini_only, now=NOW)
        self.assertEqual(res2["target"], "antigravity")
        self.assertEqual(res2["agy_account"], "u1")

    def test_u1_unavailable_or_3p_5h_exhausted_skipped(self):
        accounts = [
            claude_acct("c1", reset_in=48 * 3600),
            agy_acct("silo:u1", name="u1", silo=True, w_rem=50.0, w_reset_in=6 * 3600, unavailable=True),
            agy_acct("p1", silo=False, w_rem=50.0, w_reset_in=6 * 3600, h_rem=0.0, h_reset_in=1800),
        ]
        res = decide_claude_route(accounts, now=NOW)
        self.assertEqual(res["target"], "claude")
        self.assertEqual(res["reason"], "no_eligible_agy")

    def test_claude_pool_exhausted_falls_back_to_agy(self):
        accounts = [
            claude_acct("c1", reset_in=6 * 3600, remaining=0.0),
            agy_acct("p1", silo=False, w_rem=90.0, w_reset_in=6 * 86400),
        ]
        res = decide_claude_route(accounts, now=NOW)
        self.assertEqual(res["target"], "antigravity")
        self.assertEqual(res["agy_account"], "primary")
        self.assertEqual(res["reason"], "claude_pool_unavailable")

    def test_personal_agy_ignores_proxy_403_cooldown_while_u1_unavailable_still_blocks(self):
        primary = agy_acct("p1", silo=False, w_rem=100.0, w_reset_in=None, unavailable=True)
        primary["cooldown_until"] = NOW + 1800
        u1 = agy_acct("silo:u1", name="u1", silo=True, w_rem=100.0, w_reset_in=None, unavailable=True)
        res = decide_claude_route([claude_acct("c1", reset_in=48 * 3600), primary, u1], now=NOW)
        self.assertEqual(res["target"], "antigravity")
        self.assertEqual(res["agy_account"], "primary")
        self.assertEqual(res["agy_order"], ["primary"])


class TestClaudeRoutingEndpoint(unittest.TestCase):
    def test_loopback_allowed_and_remote_requires_auth(self):
        import io
        import json
        import server

        class FakeHub:
            def __init__(self):
                self.calls = []

            def claude_routing_decision(self, model="claude-opus-5-5", claim=False):
                self.calls.append((model, claim))
                return {"target": "antigravity", "agy_account": "primary", "agy_order": ["primary"], "model": model}

            @staticmethod
            def management_key():
                return "secret-mgmt-key"

        def invoke(path, host, client_ip, extra_headers=None):
            hub = FakeHub()
            sent = {}

            class DummyHandler(server.Handler):
                def __init__(self):
                    self.command = "GET"
                    self.path = path
                    self.client_address = (client_ip, 54321)
                    self.headers = {"Host": host, **(extra_headers or {})}
                    self.rfile = io.BytesIO(b"")
                    self.server = type("S", (), {"hub": hub})()

                def send(self, status, body, **_kw):
                    sent["status"] = status
                    sent["body"] = body

            h = DummyHandler()
            h.route()
            return sent, hub

        local_host = next(iter(server.LOCAL_HOSTS))
        # Loopback without cookies/bearer succeeds.
        res, hub = invoke("/api/routing/claude?model=claude-opus-5-5&claim=1", local_host, "127.0.0.1")
        self.assertEqual(res["status"], 200)
        self.assertEqual(res["body"]["target"], "antigravity")
        self.assertEqual(hub.calls, [("claude-opus-5-5", True)])

        # Proxied request (X-Forwarded-For) does not get loopback bypass -> 401.
        res_xff, _ = invoke("/api/routing/claude?model=claude-opus-5-5", local_host, "127.0.0.1",
                            extra_headers={"X-Forwarded-For": "100.64.0.2"})
        self.assertEqual(res_xff["status"], 401)

        # Management bearer token works even when proxied.
        res_auth, _ = invoke("/api/routing/claude?model=claude-opus-5-5", local_host, "127.0.0.1",
                             extra_headers={"X-Forwarded-For": "100.64.0.2", "Authorization": "Bearer secret-mgmt-key"})
        self.assertEqual(res_auth["status"], 200)


if __name__ == "__main__":
    unittest.main()
