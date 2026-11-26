"""Tests for Codex Team 2x default weight and natural account ordering."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import request_inputs
import server as dashboard_server


class TeamAccountsTests(unittest.TestCase):
    def test_codex_team_defaults_to_2x_while_idlenet_business_stays_1x(self):
        w = request_inputs.default_plan_weight
        self.assertEqual(w("codex", "team"), 2.0)
        self.assertEqual(w("codex", "Team"), 2.0)
        self.assertEqual(w("codex", "plus"), 1.0)
        self.assertEqual(w("codex", "ChatGPT Business Slot 1"), 1.0)
        self.assertEqual(w("codex", "Business · Standard"), 1.0)
        self.assertEqual(w("codex", "Business · Premium"), 5.0)

    def test_snapshot_sorts_hub_accounts_naturally_by_nickname(self):
        with tempfile.TemporaryDirectory() as folder:
            store = dashboard_server.Store(Path(folder) / "history.sqlite")
            store.set_nickname("codex-17a91fa0-a@x.com-plus.json", "PLUS 1")
            store.set_nickname("codex-823ee5ea-b@x.com-plus.json", "PLUS 2")
            store.set_nickname("codex-62a37559-c@x.com-team.json", "TEAM 3")
            store.set_nickname("codex-62a37559-l@x.com-team.json", "TEAM 4")
            store.set_nickname("codex-62a37559-s1@x.com-team.json", "TEAM 2")
            store.set_nickname("codex-62a37559-s2@x.com-team.json", "TEAM 1")
            store.set_nickname("codex-62a37559-z@x.com-team.json", "TEAM 10")
            hub = dashboard_server.Hub(store)
            hub.files = [
                {"auth_index": "p1", "provider": "codex", "email": "a@x.com", "name": "codex-17a91fa0-a@x.com-plus.json", "id_token": {"plan_type": "plus"}},
                {"auth_index": "t3", "provider": "codex", "email": "c@x.com", "name": "codex-62a37559-c@x.com-team.json", "id_token": {"plan_type": "team"}},
                {"auth_index": "t4", "provider": "codex", "email": "l@x.com", "name": "codex-62a37559-l@x.com-team.json", "id_token": {"plan_type": "team"}},
                {"auth_index": "t2", "provider": "codex", "email": "s1@x.com", "name": "codex-62a37559-s1@x.com-team.json", "id_token": {"plan_type": "team"}},
                {"auth_index": "t1", "provider": "codex", "email": "s2@x.com", "name": "codex-62a37559-s2@x.com-team.json", "id_token": {"plan_type": "team"}},
                {"auth_index": "t10", "provider": "codex", "email": "z@x.com", "name": "codex-62a37559-z@x.com-team.json", "id_token": {"plan_type": "team"}},
                {"auth_index": "p2", "provider": "codex", "email": "b@x.com", "name": "codex-823ee5ea-b@x.com-plus.json", "id_token": {"plan_type": "plus"}},
            ]
            with patch.object(dashboard_server, "load_registry", return_value=[]):
                snap, _ = hub._snapshot(24, include_history=False)
            codex = [a for a in snap["accounts"] if a["provider"] == "codex"]
            self.assertEqual([a["nickname"] for a in codex], ["PLUS 1", "PLUS 2", "TEAM 1", "TEAM 2", "TEAM 3", "TEAM 4", "TEAM 10"])
            by_nick = {a["nickname"]: a for a in codex}
            self.assertEqual(by_nick["PLUS 1"]["weight"], 1.0)
            self.assertEqual(by_nick["TEAM 1"]["plan_weight"], 2.0)
            self.assertEqual(by_nick["TEAM 1"]["weight"], 2.0)

    def test_finish_login_sets_fast_mode_for_codex_team_only(self):
        with tempfile.TemporaryDirectory() as folder:
            hub = dashboard_server.Hub(dashboard_server.Store(Path(folder) / "history.sqlite"))
            calls = []
            hub.request = lambda path, data=None, method="GET": calls.append((method, path, data)) or {}
            hub.finish_login({"provider": "codex"}, "st1", "codex-62a37559-user@x.com-team.json")
            hub.finish_login({"provider": "codex"}, "st2", "codex-17a91fa0-user@x.com-plus.json")
            self.assertEqual(calls, [
                ("PATCH", "credentials/fields", {
                    "name": "codex-62a37559-user@x.com-team.json",
                    "websockets": True,
                    "default_service_tier": "priority",
                }),
                ("PATCH", "credentials/fields", {
                    "name": "codex-17a91fa0-user@x.com-plus.json",
                    "websockets": True,
                }),
            ])


if __name__ == "__main__":
    unittest.main()
