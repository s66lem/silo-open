import base64
import json
import sqlite3
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path

import import_history as ih
from server import Store

NOW = 1_800_000_000.0


def stamp(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def claude_line(mid, ts, out, inp=2, read=100, write=10, model="claude-opus-5-5"):
    return json.dumps({"type": "assistant", "timestamp": stamp(ts), "message": {
        "id": mid, "model": model, "usage": {"input_tokens": inp, "output_tokens": out,
                                              "cache_read_input_tokens": read, "cache_creation_input_tokens": write}}})


def token_count(ts, total_in, last_in, cached, out, five=None, week=None):
    limits = {"limit_id": "codex",
              "primary": {"used_percent": five, "window_minutes": 300, "resets_at": ts + 1000},
              "secondary": {"used_percent": week, "window_minutes": 10080, "resets_at": ts + 9000}}
    return json.dumps({"timestamp": stamp(ts), "type": "event_msg", "payload": {"type": "token_count", "info": {
        "total_token_usage": {"input_tokens": total_in, "output_tokens": out, "total_tokens": total_in + out},
        "last_token_usage": {"input_tokens": last_in, "cached_input_tokens": cached, "output_tokens": out}}, "rate_limits": limits}})


def id_token(email):
    body = base64.urlsafe_b64encode(json.dumps({"email": email}).encode()).decode().rstrip("=")
    return f"x.{body}.y"


HUB = [{"auth_index": "c1", "name": "claude-069d75a2-main@example.com.json", "provider": "claude"},
       {"auth_index": "x1", "name": "codex-17a91fa0-codexer@example.com-plus.json", "provider": "codex"}]


class ImportTests(unittest.TestCase):
    def test_hub_accounts_match_by_provider_and_email(self):
        hub = ih.hub_accounts(HUB + [{"auth_index": "n", "name": "devin-user-1.json", "provider": "devin"}])
        self.assertEqual(hub[("claude", "main@example.com")], {"auth_index": "c1", "name": "claude-069d75a2-main@example.com.json"})
        self.assertEqual(set(hub), {("claude", "main@example.com"), ("codex", "codexer@example.com")})

    def test_claude_message_ids_count_once_with_their_largest_figures(self):
        with tempfile.TemporaryDirectory() as d:
            a, b = Path(d) / "a.jsonl", Path(d) / "b.jsonl"
            a.write_text("\n".join([claude_line("m1", NOW, out=5), claude_line("m1", NOW + 1, out=90), claude_line("m2", NOW, out=7, model="<synthetic>"),
                                    claude_line("old", NOW - 40 * 86400, out=1), "not json", json.dumps({"type": "user"})]))
            b.write_text(claude_line("m1", NOW + 2, out=90))  # the same message copied into a resumed session
            seen = set()
            rows = list(ih.claude_usage(a, NOW - 30 * 86400, seen)) + list(ih.claude_usage(b, NOW - 30 * 86400, seen))
        self.assertEqual(len(rows), 1)
        mid, ts, model, inp, out, read, write = rows[0]
        self.assertEqual((mid, ts, model, inp, out, read, write), ("m1", NOW, "claude-opus-5-5", 2, 90, 100, 10))

    def test_codex_events_dedupe_and_turn_quota_windows_into_remaining(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "s.jsonl"
            turn = json.dumps({"type": "turn_context", "payload": {"model": "gpt-x"}})
            f.write_text("\n".join([turn, token_count(NOW, 1000, 1000, 400, 50, five=15, week=20),
                                    token_count(NOW, 1000, 1000, 400, 50, five=15, week=20),  # repeated event
                                    token_count(NOW + 60, 1500, 500, 100, 10, five=16, week=20)]))
            events = list(ih.codex_events(f, NOW - 86400, set()))
        tokens = [e for e in events if e[0] == "tokens"]
        self.assertEqual([(t[2], t[3], t[4], t[5]) for t in tokens], [("gpt-x", 1000, 50, 400), ("gpt-x", 500, 10, 100)])
        quota = ih.window_sample("codex", NOW, events[1][2])
        self.assertEqual(quota, (NOW, "rate_limit:5h", 85.0, NOW + 1000, 18000.0))
        self.assertEqual(ih.window_sample("codex", NOW, events[1][3])[1:3], ("rate_limit:7d", 80.0))
        self.assertIsNone(ih.window_sample("codex", NOW, {"used_percent": 3, "window_minutes": 77}))
        self.assertIsNone(ih.window_sample("codex", NOW, {"window_minutes": 300}))

    def test_thin_keeps_the_last_exact_sample_of_each_minute(self):
        rows = [(100.5, "m", 90.0, None, 1.0), (110.25, "m", 89.0, None, 1.0), (170.0, "m", 88.0, None, 1.0), (105.0, "n", 5.0, None, 1.0)]
        self.assertEqual(ih.thin(rows), [(105.0, "n", 5.0, None, 1.0), (110.25, "m", 89.0, None, 1.0), (170.0, "m", 88.0, None, 1.0)])

    def make_home(self, root):
        for name, email in ((".claude", "main@example.com"), (".claude-other", "someone@else.example")):
            (root / name / "projects" / "p").mkdir(parents=True)
            (root / name / ".claude.json").write_text(json.dumps({"oauthAccount": {"emailAddress": email}}))
            (root / name / "projects" / "p" / "s.jsonl").write_text(claude_line("id-" + name, time.time() - 3600, out=40))
        (root / ".codex" / "sessions").mkdir(parents=True)
        (root / ".codex" / "auth.json").write_text(json.dumps({"tokens": {"id_token": id_token("codexer@example.com")}}))
        (root / ".codex" / "sessions" / "r.jsonl").write_text(token_count(time.time() - 3600, 900, 900, 300, 20, five=10, week=30))
        (root / ".codex-nologin").mkdir()

    def test_collect_imports_only_hub_logins_and_lists_the_rest(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            self.make_home(root)
            now = time.time()
            usage = {"accounts": {"MAIN": {"history": [[now - 600, 8.0, 18.0], [now - 100 * 86400, 1.0, 1.0]]},
                                  "SLOT-1": {"history": [[now - 600, 50.0, 50.0]]}}}
            buckets, quota, skipped = ih.collect(root, ih.hub_accounts(HUB), usage, 30, now=now)
        accounts = {k[2] for k in buckets}
        self.assertEqual(accounts, {"claude-069d75a2-main@example.com.json", "codex-17a91fa0-codexer@example.com-plus.json"})
        self.assertTrue(any(".claude-other" in s and "not a hub account" in s for s in skipped))
        self.assertTrue(any(".codex-nologin" in s for s in skipped))
        claude = quota["c1"][1]  # usage.json MAIN: used % becomes remaining %, the 100-day-old point is dropped
        self.assertEqual(sorted((r[1], r[2]) for r in claude), [("five_hour", 92.0), ("seven_day", 82.0)])
        self.assertEqual({r[1]: r[2] for r in quota["x1"][1]}, {"rate_limit:5h": 90.0, "rate_limit:7d": 70.0})
        total = [b for k, b in buckets.items() if k[1] == "codex"][0]
        self.assertEqual(total, [1, 900, 20, 300, 0])

    def test_write_is_repeatable_keeps_live_samples_and_can_be_removed(self):
        with tempfile.TemporaryDirectory() as d:
            db = Path(d) / "quota.sqlite"
            store = Store(db)
            live = {"observed_at": NOW, "windows": [{"id": "five_hour", "remaining": 50, "reset_at": None, "period": 18000}]}
            store.save("c1", "claude", live)
            hub = ih.hub_accounts(HUB)
            buckets = {(int(NOW // 3600 * 3600), "claude", "claude-069d75a2-main@example.com.json", "m"): [3, 10, 20, 30, 5]}
            quota = {"c1": ("claude", [(NOW - 7200, "five_hour", 70.0, None, 18000.0)])}
            for _ in range(2):  # a second run replaces the first import instead of adding to it
                ih.write(db, buckets, quota, hub)
            con = sqlite3.connect(db)
            self.assertEqual(con.execute("SELECT COUNT(*) FROM samples_imported").fetchone()[0], 1)
            self.assertEqual(con.execute("SELECT COUNT(*) FROM tokens_imported").fetchone()[0], 1)
            self.assertEqual(con.execute("SELECT remaining FROM samples").fetchall(), [(50.0,)])
            con.close()
            rows = Store(db).imported_buckets(0)
            self.assertEqual((rows[0]["key_id"], rows[0]["input_tokens"], rows[0]["cache_write_tokens"], rows[0]["tokens"]), ("imported", 10, 5, 35))
            ih.remove(db)
            self.assertEqual(Store(db).imported_buckets(0), [])
            self.assertEqual(len(Store(db).history(24 * 30 * 400)), 1)  # only the live sample is left

    def test_antigravity_transcripts_import_alone_and_leave_other_rows(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            now = time.time()
            home = root / ".t3/userdata/providers/antigravity/abc/antigravity-acp"
            logs = home / "brain/conv1/.system_generated/logs"
            logs.mkdir(parents=True)
            (home / "antigravity-oauth-token").write_text(json.dumps({"token": "t", "id_token_email": "Agy@Example.com"}))
            step = lambda i, ts, inp, read, out: json.dumps({"step_index": i, "source": "MODEL", "type": "PLANNER_RESPONSE", "created_at": stamp(ts),
                                                             "model": "gemini-4-neon-high", "input_tokens": inp, "cache_read_tokens": read, "output_tokens": out})
            (logs / "transcript.jsonl").write_text("\n".join([
                json.dumps({"step_index": 0, "source": "USER_EXPLICIT", "created_at": stamp(now - 60), "content": "hi"}),
                step(1, now - 60, 35000, 0, 300), step(1, now - 60, 35000, 0, 300),  # a repeated line counts once
                step(4, now - 50, 4000, 35000, 200), step(9, now - 40 * 86400, 9, 9, 9), "not json"]))
            hub = ih.hub_accounts(HUB + [{"auth_index": "g1", "name": "antigravity-agy@example.com.json", "provider": "antigravity"}])
            self.make_home(root)
            buckets, quota, skipped = ih.collect(root, hub, None, 30, now=now, sources=("antigravity",))
            self.assertEqual({k[1:] for k in buckets}, {("antigravity", "antigravity-agy@example.com.json", "gemini-4-neon-high")})
            total = [sum(col) for col in zip(*buckets.values())]
            self.assertEqual(total, [2, 35000 + 39000, 500, 35000, 0])  # input includes cache reads, like live Gemini buckets
            self.assertEqual((quota, skipped), ({}, []))

            db = root / "quota.sqlite"
            ih.write(db, {(int(now // 3600 * 3600), "claude", "c", "m"): [1, 1, 1, 1, 1]}, {}, hub)
            ih.write(db, buckets, quota, hub, ("antigravity",))
            ih.write(db, buckets, quota, hub, ("antigravity",))  # re-running replaces only the Antigravity rows
            con = sqlite3.connect(db)
            self.assertEqual(sorted(con.execute("SELECT provider, requests FROM tokens_imported")), [("antigravity", 2), ("claude", 1)])
            con.close()

    def test_history_unions_imported_samples_without_touching_live_ones(self):
        with tempfile.TemporaryDirectory() as d:
            db = Path(d) / "quota.sqlite"
            store = Store(db)
            now = time.time()
            store.save("c1", "claude", {"observed_at": now, "windows": [{"id": "five_hour", "remaining": 50, "reset_at": None, "period": 18000}]})
            ih.write(db, {}, {"c1": ("claude", [(now - 7200, "five_hour", 70.0, None, 18000.0)])}, ih.hub_accounts(HUB))
            rows = Store(db).history(24)
            self.assertEqual(sorted(r["remaining"] for r in rows), [50.0, 70.0])


if __name__ == "__main__":
    unittest.main()
