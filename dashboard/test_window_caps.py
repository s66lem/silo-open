"""Tests for separate 5h / weekly usage caps on Idlenet (Silo) seats."""
import http.client
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server as dashboard_server
import silo_accounts
from server import Handler, Hub, Store, ThreadingHTTPServer
from test_server import FakeHubAPI, silo_entry


def win(wid, label, used, reset_at, period, group=None):
    item = {"id": wid, "label": label, "remaining": 100 - used, "reset_at": reset_at, "period": period}
    if group:
        item["group"] = group
    return item


class WindowCapHelperTests(unittest.TestCase):
    def test_cap_window_key_classifies_periods_and_ids(self):
        self.assertEqual(silo_accounts.cap_window_key({"id": "five_hour", "period": 5 * 3600}), "5h")
        self.assertEqual(silo_accounts.cap_window_key({"id": "seven_day", "period": 7 * 86400}), "weekly")
        self.assertEqual(silo_accounts.cap_window_key({"id": "rate_limit:5h", "period": 18000}), "5h")
        self.assertEqual(silo_accounts.cap_window_key({"id": "rate_limit:7d", "period": 604800}), "weekly")
        self.assertEqual(silo_accounts.cap_window_key({"id": "weekly_scoped:fable_5", "period": 604800}), "weekly")
        self.assertEqual(silo_accounts.cap_window_key({"id": "gemini:5h", "label": "Gemini · 5-hour limit"}), "5h")
        self.assertEqual(silo_accounts.cap_window_key({"id": "3p-weekly", "label": "Claude & GPT · Weekly limit"}), "weekly")
        self.assertIsNone(silo_accounts.cap_window_key({"id": "custom", "label": "Monthly", "period": 30 * 86400}))

    def test_clean_cap_window_validation(self):
        self.assertIsNone(silo_accounts.clean_cap_window(None))
        self.assertIsNone(silo_accounts.clean_cap_window(""))
        self.assertEqual(silo_accounts.clean_cap_window("5h"), "5h")
        self.assertEqual(silo_accounts.clean_cap_window("weekly"), "weekly")
        for bad in ("7d", "daily", 5, True, [], {}):
            with self.subTest(bad=bad), self.assertRaises(dashboard_server.InputError):
                silo_accounts.clean_cap_window(bad)

    def test_cap_precedence_and_registry_validation(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "reg.json"
            path.write_text(json.dumps([
                silo_entry("s1", "claude", cap_percent=85,
                           window_caps={"5h": 95, "weekly": 80, "bad": 50, "low": 0, "bool": True}),
                silo_entry("u1", "antigravity", cap_percent=90,
                           window_caps={"5h": 95},
                           group_caps={"Gemini": {"5h": 98, "weekly": 82, "bad": 10}, "Claude & GPT": 85}),
            ]))
            reg = dashboard_server.parse_registry(path)
            s1, u1 = reg
            self.assertEqual(s1["window_caps"], {"5h": 95, "weekly": 80})
            self.assertEqual(u1["window_caps"], {"5h": 95})
            self.assertEqual(u1["group_caps"], {"Claude & GPT": 85})
            self.assertEqual(u1["group_window_caps"], {"Gemini": {"5h": 98, "weekly": 82}})

            # Seat-level precedence: window override > account override > registry window_caps > cap_percent.
            self.assertEqual(silo_accounts.silo_window_caps(s1), {"5h": 95, "weekly": 80})
            self.assertEqual(silo_accounts.silo_window_caps(s1, {"s1": 88}), {"5h": 88, "weekly": 88})
            self.assertEqual(silo_accounts.silo_window_caps(s1, {"s1": 88}, {("", "5h"): 92}), {"5h": 92, "weekly": 88})

            # Group-level precedence: (grp, win) > grp > ("", win) > acct > reg group_window > reg group > reg win > base.
            self.assertEqual(silo_accounts.silo_window_caps(u1, group="Gemini"), {"5h": 98, "weekly": 82})
            self.assertEqual(silo_accounts.silo_window_caps(u1, group="Claude & GPT"), {"5h": 85, "weekly": 85})
            self.assertEqual(silo_accounts.silo_window_caps(u1, group="Other"), {"5h": 95, "weekly": 90})
            self.assertEqual(
                silo_accounts.silo_window_caps(u1, {}, {("Gemini", "weekly"): 75}, group="Gemini", account_group_overrides={"Gemini": 88}),
                {"5h": 88, "weekly": 75},
            )

    def test_cap_reason_formats_separate_caps_accurately(self):
        now = 1_795_500_000
        w5 = win("five_hour", "5-hour limit", 92, now + 3600, 5 * 3600)
        w7 = win("seven_day", "Weekly limit", 86, now + 86400, 7 * 86400)
        # 5h is 92% (under 95% cap), weekly is 86% (over 85% cap) -> only weekly named with 85% cap.
        self.assertEqual(
            silo_accounts.cap_reason([w5, w7], 85, used=92, window_caps={"5h": 95, "weekly": 85}),
            "Weekly limit at 86% (85% cap)",
        )
        # Both hit with different caps -> each shows its own cap.
        w5_hi = win("five_hour", "5-hour limit", 96, now + 3600, 5 * 3600)
        self.assertEqual(
            silo_accounts.cap_reason([w5_hi, w7], 85, used=96, window_caps={"5h": 95, "weekly": 85}),
            "5-hour limit at 96% (95% cap), Weekly limit at 86% (85% cap)",
        )
        # Neither hits its window cap even though scalar used >= base cap -> never reports false base cap hit.
        w5_ok = win("five_hour", "5-hour limit", 90, now + 3600, 5 * 3600)
        w7_ok = win("seven_day", "Weekly limit", 70, now + 86400, 7 * 86400)
        self.assertEqual(
            silo_accounts.cap_reason([w5_ok, w7_ok], 85, used=90, window_caps={"5h": 95, "weekly": 85}),
            "Waiting for reset confirmation",
        )


class WindowCapEnforcementTests(unittest.TestCase):
    def setUp(self):
        folder = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.path = folder / "reg.json"
        self.hub = Hub(Store(folder / "h.sqlite"))
        self.now = 1_795_500_000.0
        self.r5 = self.now + 2 * 3600
        self.r7 = self.now + 4 * 86400

    def test_claude_seat_enforces_5h_and_weekly_caps_independently(self):
        self.path.write_text(json.dumps([silo_entry("s1", "claude", cap_percent=85, window_caps={"5h": 95, "weekly": 85})]))
        api = FakeHubAPI(family="claude", account="s1")

        def run(windows, fresh=True):
            if fresh and "s1" in self.hub.remote_quotas:
                self.hub.remote_quotas["s1"]["observed_at"] = 0
            top = max(windows, key=lambda w: 100 - w["remaining"])
            with patch.object(dashboard_server, "SILO_REGISTRY", self.path), \
                    patch.object(dashboard_server.time, "time", return_value=self.now), \
                    patch.object(self.hub, "request", side_effect=api), \
                    patch.object(self.hub, "_remote_fetch", return_value=(100 - top["remaining"], top["reset_at"], windows)) as fetch:
                self.hub.enforce_caps()
            return fetch

        # 5h at 92% (<95% cap), weekly at 80% (<85% cap) -> stays active!
        run([win("five_hour", "5-hour limit", 92, self.r5, 5 * 3600),
             win("seven_day", "Weekly limit", 80, self.r7, 7 * 86400)])
        self.assertFalse(api.paused())
        self.assertEqual(self.hub.store.cap_state(), {})

        # 5h stays 92% (still highest used_percent!), weekly crosses 85% cap -> paused until WEEKLY reset (r7), not r5!
        run([win("five_hour", "5-hour limit", 92, self.r5, 5 * 3600),
             win("seven_day", "Weekly limit", 86, self.r7, 7 * 86400)])
        self.assertTrue(api.paused())
        state = self.hub.store.cap_state()["s1"]
        self.assertEqual(state["capped_until"], self.r7)
        self.assertEqual(state["reason"], "Weekly limit at 86% (85% cap)")

        # Owner raises weekly cap to 90% -> cached reading immediately unpauses on next enforce!
        self.hub.store.set_cap_window_override("s1", "", "weekly", 90)
        run([win("five_hour", "5-hour limit", 92, self.r5, 5 * 3600),
             win("seven_day", "Weekly limit", 86, self.r7, 7 * 86400)], fresh=False).assert_not_called()
        self.assertFalse(api.paused())
        self.assertEqual(self.hub.store.cap_state(), {})

        # 5h crosses 95% cap while weekly is 86% (<90% cap) -> paused until 5h reset (r5).
        run([win("five_hour", "5-hour limit", 96, self.r5, 5 * 3600),
             win("seven_day", "Weekly limit", 86, self.r7, 7 * 86400)])
        self.assertTrue(api.paused())
        state = self.hub.store.cap_state()["s1"]
        self.assertEqual(state["capped_until"], self.r5)
        self.assertEqual(state["reason"], "5-hour limit at 96% (95% cap)")

        # Weekly ALSO crosses 90% while 5h is capped -> capped_until advances to r7 and reason lists both!
        run([win("five_hour", "5-hour limit", 96, self.r5, 5 * 3600),
             win("seven_day", "Weekly limit", 91, self.r7, 7 * 86400)])
        state = self.hub.store.cap_state()["s1"]
        self.assertEqual(state["capped_until"], self.r7)
        self.assertEqual(state["reason"], "5-hour limit at 96% (95% cap), Weekly limit at 91% (90% cap)")

        # Non-binding window reset passes while 5h is still active -> remote_usage must re-fetch (no stale cache).
        self.hub.store.set_cap_window_override("s1", "", "weekly", 85)
        run([win("five_hour", "5-hour limit", 90, self.now + 5000, 5 * 3600),
             win("seven_day", "Weekly limit", 86, self.now + 10, 7 * 86400)])
        self.assertTrue(api.paused())
        self.now += 20
        fetch = run([win("five_hour", "5-hour limit", 90, self.now + 5000, 5 * 3600),
                     win("seven_day", "Weekly limit", 5, self.now + 7 * 86400, 7 * 86400)], fresh=False)
        fetch.assert_called_once()
        self.assertFalse(api.paused())

    def test_antigravity_group_enforces_separate_5h_and_weekly_caps(self):
        self.path.write_text(json.dumps([
            silo_entry("u1", "antigravity", cap_percent=85,
                       group_caps={"Gemini": {"5h": 95, "weekly": 80}, "Claude & GPT": {"5h": 90, "weekly": 85}}),
        ]))
        api = FakeHubAPI(groups=[{"name": "u1", "disabled": False, "keys": [{"api-key": "A"}]}],
                         family="openai-compatibility", account="u1")

        def run(windows):
            if "u1" in self.hub.remote_quotas:
                self.hub.remote_quotas["u1"]["observed_at"] = 0
            top = max(windows, key=lambda w: 100 - w["remaining"])
            with patch.object(dashboard_server, "SILO_REGISTRY", self.path), \
                    patch.object(dashboard_server.time, "time", return_value=self.now), \
                    patch.object(self.hub, "request", side_effect=api), \
                    patch.object(self.hub, "_remote_fetch", return_value=(100 - top["remaining"], top["reset_at"], windows)):
                self.hub.enforce_caps()

        # Gemini 5h=92% (<95%), Gemini weekly=75% (<80%); Claude & GPT 5h=88% (<90%), weekly=82% (<85%) -> none capped.
        run([
            win("gem:5h", "Gemini · 5-hour limit", 92, self.r5, 5 * 3600, group="Gemini"),
            win("gem:weekly", "Gemini · Weekly limit", 75, self.r7, 7 * 86400, group="Gemini"),
            win("3p:5h", "Claude & GPT · 5-hour limit", 88, self.r5, 5 * 3600, group="Claude & GPT"),
            win("3p:weekly", "Claude & GPT · Weekly limit", 82, self.r7, 7 * 86400, group="Claude & GPT"),
        ])
        self.assertEqual(self.hub.store.cap_group_state(), {})
        self.assertNotIn("excluded-models", api.config["openai-compatibility"][0])

        # Gemini weekly crosses 80% while Gemini 5h is 92% (<95%) -> only Gemini excluded until r7!
        run([
            win("gem:5h", "Gemini · 5-hour limit", 92, self.r5, 5 * 3600, group="Gemini"),
            win("gem:weekly", "Gemini · Weekly limit", 81, self.r7, 7 * 86400, group="Gemini"),
            win("3p:5h", "Claude & GPT · 5-hour limit", 88, self.r5, 5 * 3600, group="Claude & GPT"),
            win("3p:weekly", "Claude & GPT · Weekly limit", 82, self.r7, 7 * 86400, group="Claude & GPT"),
        ])
        self.assertEqual(api.config["openai-compatibility"][0]["excluded-models"], ["gemini-*", "tab_*"])
        gm = self.hub.store.cap_group_state()["u1"]["Gemini"]
        self.assertEqual(gm["capped_until"], self.r7)
        self.assertEqual(gm["reason"], "Weekly limit at 81% (80% cap)")


class WindowCapAPITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.TemporaryDirectory()
        cls.hub = Hub(Store(Path(cls.folder.name) / "test.sqlite"))
        cls.hub.management_key = lambda: "test-only-key"
        cls.hub.files = []
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

    def request(self, path, body=None, cookie=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port)
        headers = {"Host": "localhost:8318", "X-Dashboard-Request": "1", "Content-Type": "application/json"}
        if cookie:
            headers["Cookie"] = cookie
        conn.request("GET" if body is None else "POST", "/dashboard/api/" + path,
                     body=json.dumps(body) if body is not None else None, headers=headers)
        res = conn.getresponse()
        result = res.status, json.loads(res.read()), res.getheader("Set-Cookie")
        conn.close()
        return result

    def login(self):
        status, _, cookie = self.request("login", {"key": "test-only-key"})
        self.assertEqual(status, 200)
        return cookie.split(";")[0]

    def test_account_cap_api_sets_clears_and_exposes_window_caps(self):
        cookie = self.login()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "reg.json"
            path.write_text(json.dumps([
                silo_entry("s1", "claude", cap_percent=85),
                silo_entry("u1", "antigravity", cap_percent=90),
            ]))
            with patch.object(dashboard_server, "SILO_REGISTRY", path):
                # Invalid window rejected.
                self.assertEqual(self.request("account/cap", {"id": "silo:s1", "window": "7d", "cap_percent": 95}, cookie=cookie)[0], 400)
                # Set separate 5h and weekly caps on Claude seat.
                self.assertEqual(
                    self.request("account/cap", {"id": "silo:s1", "window": "5h", "cap_percent": 95}, cookie=cookie)[:2],
                    (200, {"cap_percent": 95, "window": "5h"}),
                )
                self.assertEqual(
                    self.request("account/cap", {"id": "silo:s1", "window": "weekly", "cap_percent": 80}, cookie=cookie)[:2],
                    (200, {"cap_percent": 80, "window": "weekly"}),
                )
                # Set per-group window cap on Antigravity seat.
                self.assertEqual(
                    self.request("account/cap", {"id": "silo:u1", "group": "Gemini", "window": "5h", "cap_percent": 95}, cookie=cookie)[:2],
                    (200, {"cap_percent": 95, "group": "Gemini", "window": "5h"}),
                )
                snap = self.hub.snapshot(24)
                s1_acct = next(a for a in snap["accounts"] if a["id"] == "silo:s1")
                s1_silo = next(s for s in snap["silo"] if s["id"] == "silo:s1")
                self.assertEqual(s1_acct["window_caps"], {"5h": 95, "weekly": 80})
                self.assertEqual(s1_silo["window_caps"], {"5h": 95, "weekly": 80})
                u1_acct = next(a for a in snap["accounts"] if a["id"] == "silo:u1")
                self.assertEqual(u1_acct["group_caps"][0]["group"], "Gemini")
                self.assertEqual(u1_acct["group_caps"][0]["window_caps"], {"5h": 95, "weekly": 90})

                # Clearing a window override falls back to base cap.
                self.assertEqual(
                    self.request("account/cap", {"id": "silo:s1", "window": "5h", "cap_percent": None}, cookie=cookie)[:2],
                    (200, {"cap_percent": None, "window": "5h"}),
                )
                snap2 = self.hub.snapshot(24)
                s1_after = next(a for a in snap2["accounts"] if a["id"] == "silo:s1")
                self.assertEqual(s1_after["window_caps"], {"5h": 85, "weekly": 80})

                # Setting a unified seat/group cap clears per-window overrides for that scope so it takes effect.
                self.assertEqual(
                    self.request("account/cap", {"id": "silo:s1", "cap_percent": 90}, cookie=cookie)[:2],
                    (200, {"cap_percent": 90}),
                )
                snap3 = self.hub.snapshot(24)
                s1_unified = next(a for a in snap3["accounts"] if a["id"] == "silo:s1")
                self.assertEqual(s1_unified["window_caps"], {"5h": 90, "weekly": 90})


if __name__ == "__main__":
    unittest.main()
