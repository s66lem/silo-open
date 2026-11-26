"""Tests for snapshot pooled-series downsampling, compact encoding, and Windows client-abort handling."""
import json
import os
import sys
import unittest
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import history_store
import server as dashboard_server


class SnapshotTrimTest(unittest.TestCase):
    def test_downsample_series_coalesces_bucket_and_preserves_gaps(self):
        pts = [
            {"ts": 10, "value": 100},
            {"ts": 45, "value": 98},
            {"ts": 110, "value": 95},
            {"ts": 130, "value": 90},
            {"ts": 200, "value": 85},
            {"ts": 210, "value": 80, "gap": True},  # mid-bucket gap
            {"ts": 230, "value": 78},
            {"ts": 2000, "value": 60, "gap": True},  # cross-bucket gap
            {"ts": 2020, "value": 58},
        ]
        got = history_store.downsample_series(pts, 120)
        self.assertEqual(
            [(p["ts"], p["value"], bool(p.get("gap"))) for p in got],
            [
                (110, 95, False),
                (200, 85, False),
                (230, 78, True),
                (2020, 58, True),
            ],
        )
        # Disabled / empty pass through unchanged
        self.assertEqual(history_store.downsample_series(pts, None), pts)
        self.assertEqual(history_store.downsample_series([], 120), [])

    def test_hub_totals_caps_pooled_points_to_bucket_count_with_staggered_accounts(self):
        # 6 accounts across 3 providers reporting at staggered timestamps inside 10 buckets of 120s.
        accounts = [
            {"id": "c1", "provider": "claude", "weight": 1, "windows": [{"id": "five_hour", "period": 5 * 3600}]},
            {"id": "c2", "provider": "claude", "weight": 1, "windows": [{"id": "five_hour", "period": 5 * 3600}]},
            {"id": "x1", "provider": "codex", "weight": 1, "windows": [{"id": "rate_limit:5h", "period": 5 * 3600}]},
            {"id": "x2", "provider": "codex", "weight": 1, "windows": [{"id": "rate_limit:5h", "period": 5 * 3600}]},
            {"id": "d1", "provider": "devin", "weight": 1, "windows": [{"id": "daily", "period": 86400}]},
            {"id": "d2", "provider": "devin", "weight": 1, "windows": [{"id": "daily", "period": 86400}]},
        ]
        spec = [
            ("c1", "claude", "five_hour", 5),
            ("c2", "claude", "five_hour", 25),
            ("x1", "codex", "rate_limit:5h", 45),
            ("x2", "codex", "rate_limit:5h", 65),
            ("d1", "devin", "daily", 85),
            ("d2", "devin", "daily", 105),
        ]
        history = []
        for b in range(10):
            base_ts = 10000 + b * 120
            for aid, prov, metric, offset in spec:
                history.append({
                    "ts": base_ts + offset,
                    "account": aid,
                    "provider": prov,
                    "metric": metric,
                    "remaining": 100 - b * 2,
                    "reset_at": None,
                    "period": 5 * 3600,
                })
        totals = dashboard_server.Hub.totals(accounts, history, 120)
        # Without bucketing, totals["all"]["5h"]["points"] would have ~60 staggered points.
        all_pts = totals["all"]["5h"]["points"]
        self.assertLessEqual(len(all_pts), 11)
        self.assertEqual(all_pts[-1]["ts"], 10000 + 9 * 120 + 105)
        self.assertEqual(all_pts[-1]["value"], 6 * (100 - 18))
        for prov, metric in (("claude", "five_hour"), ("codex", "rate_limit:5h"), ("devin", "daily")):
            self.assertLessEqual(len(totals[prov][metric]), 11)
            self.assertEqual(totals[prov][metric][-1]["value"], 2 * (100 - 18))

    def test_handle_route_ignores_connection_aborted_error(self):
        handler = dashboard_server.Handler.__new__(dashboard_server.Handler)
        handler.route = MagicMock(side_effect=ConnectionAbortedError(10053, "aborted"))
        handler.send = MagicMock()
        handler.handle_route()
        handler.send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
