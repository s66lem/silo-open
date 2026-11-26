"""Tests for pooled quota history continuity when accounts stop reporting
(Sign-in needed, offline capped Idlenet seats, or Quota unavailable)."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import history_store
import server as dashboard_server


class QuotaUnavailableHistoryTests(unittest.TestCase):
    def test_totals_carry_forward_signed_out_capped_and_quota_unavailable_accounts(self):
        accounts = [
            {"id": "team1", "provider": "codex", "weight": 2.0, "quota_at": 4000,
             "windows": [{"id": "rate_limit:7d", "remaining": 50.0, "period": 7 * 86400}]},
            {"id": "plus1", "provider": "codex", "weight": 1.0, "requires_sign_in": True, "quota_at": 600,
             "quota_error": "HTTP 401",
             "windows": [{"id": "rate_limit:7d", "remaining": 50.0, "period": 7 * 86400}]},
            {"id": "silo:c1", "provider": "codex", "weight": 1.0, "silo": True, "capped": True, "disabled": True,
             "quota_at": 600, "quota_error": "Laptop unreachable.",
             "windows": [{"id": "rate_limit:7d", "remaining": 60.0, "period": 7 * 86400}]},
            {"id": "unavail1", "provider": "codex", "weight": 1.0, "quota_at": 600,
             "quota_error": "Quota request returned HTTP 502.",
             "windows": [{"id": "rate_limit:7d", "remaining": 40.0, "period": 7 * 86400}]},
        ]
        row = lambda ts, acct, rem: {"ts": ts, "account": acct, "provider": "codex", "metric": "rate_limit:7d", "remaining": rem}
        history = [
            # All 4 report through ts=600
            row(0, "team1", 90), row(0, "plus1", 50), row(0, "silo:c1", 60), row(0, "unavail1", 40),
            row(600, "team1", 80), row(600, "plus1", 50), row(600, "silo:c1", 60), row(600, "unavail1", 40),
            # Only team1 continues reporting past gap (900s)
            row(2000, "team1", 70),
            row(2600, "team1", 60),
            row(4000, "team1", 50),
        ]
        pts = dashboard_server.Hub.totals(accounts, history, 120)["codex"]["rate_limit:7d"]
        self.assertEqual([p["ts"] for p in pts], [0, 600, 2000, 2600, 4000])
        # Total carries forward plus1(50), c1(60), unavail1(40) = 150 + team1
        self.assertEqual([p["value"] for p in pts], [240, 230, 220, 210, 200])
        # Units: team1(2x * rem/100) + 0.5 + 0.6 + 0.4 = 1.5 + 2*rem/100
        self.assertAlmostEqual(pts[-1]["units"], 2.5, places=4)
        self.assertAlmostEqual(pts[-1]["weight"], 5.0, places=4)
        # Idlenet share stays accurate (c1 = 60% / 0.6x)
        self.assertAlmostEqual(pts[-1]["silo_value"], 60.0, places=4)
        self.assertAlmostEqual(pts[-1]["silo_units"], 0.6, places=4)
        # True recording outages (> 900s with zero accounts reporting) still emit gap=True.
        self.assertTrue(pts[2].get("gap"))
        self.assertNotIn("gap", pts[3])
        self.assertTrue(pts[4].get("gap"))

    def test_totals_seed_accounts_whose_last_sample_predates_the_chart_window(self):
        # On a 24h view, an account that signed out or went unavailable 2 days ago has zero rows in
        # the 24h query, but still contributes its last known value so the chart is never blanked
        # and matches the live card total.
        accounts = [
            {"id": "live1", "provider": "codex", "weight": 2.0, "quota_at": 10000,
             "windows": [{"id": "rate_limit:7d", "remaining": 70.0, "period": 7 * 86400}]},
            {"id": "stale_old", "provider": "codex", "weight": 1.0, "requires_sign_in": True,
             "quota_at": 1000, "quota_error": "HTTP 401",
             "windows": [{"id": "rate_limit:7d", "remaining": 50.0, "period": 7 * 86400}]},
            {"id": "silo:c1", "provider": "codex", "weight": 1.0, "silo": True, "capped": True,
             "quota_at": 1500, "quota_error": "Laptop unreachable.",
             "windows": [{"id": "rate_limit:7d", "remaining": 60.0, "period": 7 * 86400}]},
            # Newly added account whose quota_at is after the window start must NOT be backfilled backwards.
            {"id": "brand_new", "provider": "codex", "weight": 2.0, "quota_at": 10050,
             "windows": [{"id": "rate_limit:7d", "remaining": 100.0, "period": 7 * 86400}]},
        ]
        history = [
            {"ts": 9000, "account": "live1", "provider": "codex", "metric": "rate_limit:7d", "remaining": 80.0},
            {"ts": 9600, "account": "live1", "provider": "codex", "metric": "rate_limit:7d", "remaining": 75.0},
            {"ts": 10000, "account": "live1", "provider": "codex", "metric": "rate_limit:7d", "remaining": 70.0},
        ]
        pts = dashboard_server.Hub.totals(accounts, history, 120)["codex"]["rate_limit:7d"]
        self.assertEqual([p["ts"] for p in pts], [9000, 9600, 10000])
        # live1 + stale_old(50) + silo:c1(60); brand_new not backfilled.
        self.assertEqual([p["value"] for p in pts], [190.0, 185.0, 180.0])
        self.assertEqual([p["weight"] for p in pts], [4.0, 4.0, 4.0])
        self.assertEqual([p["silo_value"] for p in pts], [60.0, 60.0, 60.0])

    def test_carry_forward_still_joins_late_accounts_without_backfilling_them(self):
        # Adding TEAM accounts mid-week should not backfill them onto earlier days.
        row = lambda ts, acct, rem: {"ts": ts, "account": acct, "metric": "m", "remaining": rem}
        rows = [
            row(0, "c1", 70), row(500, "c1", 65),
            # c1 stops reporting after 500; team1 joins at 3000 and keeps going
            row(3000, "team1", 90), row(3500, "team1", 80),
        ]
        pts = history_store.pool_series(
            rows, ["c1", "team1"], "m", 900,
            weights={"c1": 1.0, "team1": 2.0}, silo_ids={"c1"}, carry_forward=True,
        )
        self.assertEqual([(p["ts"], p["value"], p["weight"], bool(p.get("gap"))) for p in pts], [
            (0, 70, 1.0, False),
            (500, 65, 1.0, False),
            (3000, 155, 3.0, True),
            (3500, 145, 3.0, False),
        ])


if __name__ == "__main__":
    unittest.main()
