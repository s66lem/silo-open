import http.client
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import history_store
import server as dashboard_server
import usage_breakdown


def _iso(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


class UsageBreakdownTests(unittest.TestCase):
    def _build_fixture(self, root, now):
        t3_dir = root / ".t3" / "userdata"
        t3_dir.mkdir(parents=True)
        home = root
        proj_conj = root / "projects" / "conjectures"
        proj_silo = root / "projects" / "prox"
        proj_conj.mkdir(parents=True)
        proj_silo.mkdir(parents=True)

        # 1. T3 statev2.sqlite with 2 projects, 1 root thread + 2 delegated children, and native links.
        con = sqlite3.connect(t3_dir / "statev2.sqlite")
        with con:
            con.execute(
                "CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT NOT NULL, "
                "workspace_root TEXT NOT NULL, deleted_at TEXT)"
            )
            con.execute(
                "CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, "
                "title TEXT NOT NULL, default_provider TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT, "
                "deleted_at TEXT, payload_json TEXT NOT NULL)"
            )
            con.execute(
                "CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, "
                "thread_id TEXT, provider TEXT NOT NULL, driver TEXT, provider_instance_id TEXT, payload_json TEXT NOT NULL)"
            )
            con.executemany(
                "INSERT INTO projection_projects VALUES (?,?,?,?)",
                [
                    ("p-conj", "conjectures", str(proj_conj), None),
                    ("p-silo", "silo", str(proj_silo), None),
                ],
            )
            con.executemany(
                "INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,?,?)",
                [
                    ("t-root", "p-conj", "Prove Theorem 42", "antigravity", _iso(now - 60), None, None, json.dumps({})),
                    (
                        "t-del-claude",
                        "p-conj",
                        "Opus delegate",
                        "claude_silo",
                        _iso(now - 120),
                        None,
                        None,
                        json.dumps({"lineage": {"rootThreadId": "t-root", "parentThreadId": "t-root"}}),
                    ),
                    (
                        "t-del-codex",
                        "p-conj",
                        "Codex delegate",
                        "codex_silo",
                        _iso(now - 180),
                        None,
                        None,
                        json.dumps({"lineage": {"rootThreadId": "t-root", "parentThreadId": "t-root"}}),
                    ),
                    (
                        "t-del-devin",
                        "p-silo",
                        "Devin delegate",
                        "devin_silo",
                        _iso(now - 240),
                        None,
                        None,
                        json.dumps({"worktreePath": str(root / ".t3" / "worktrees" / "prox" / "wt1")}),
                    ),
                ],
            )
            con.executemany(
                "INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?,?,?,?)",
                [
                    ("pt-agy", "t-root", "antigravity", "antigravity", "antigravity",
                     json.dumps({"nativeThreadRef": {"nativeId": "11111111-1111-1111-1111-111111111111"}})),
                    ("pt-claude", "t-del-claude", "claude_silo", "claudeAgent", "claude_silo",
                     json.dumps({"nativeThreadRef": {"nativeId": "22222222-2222-2222-2222-222222222222"}})),
                    ("pt-codex", "t-del-codex", "codex_silo", "codex", "codex_silo",
                     json.dumps({"nativeThreadRef": {"nativeId": "33333333-3333-3333-3333-333333333333"}})),
                    ("pt-devin", "t-del-devin", "devin_silo", "opencode", "devin_silo",
                     json.dumps({"nativeThreadRef": {"nativeId": "ses_devin_root"}})),
                ],
            )
        con.close()

        # 2. Antigravity parent + native subagent transcript.
        agy_parent = t3_dir / "providers" / "antigravity" / "acct1" / "antigravity-acp" / "brain" / "11111111-1111-1111-1111-111111111111" / ".system_generated" / "logs" / "transcript.jsonl"
        agy_parent.parent.mkdir(parents=True)
        agy_parent.write_text(
            "\n".join([
                json.dumps({
                    "step_index": 1, "source": "MODEL", "created_at": _iso(now - 300),
                    "model": "gemini-4-neon-high", "input_tokens": 1_000_000, "output_tokens": 100_000, "cache_read_tokens": 500_000,
                    "content": 'launched {"conversationId": "44444444-4444-4444-4444-444444444444"}',
                }),
                # Duplicate step_index should be deduplicated.
                json.dumps({
                    "step_index": 1, "source": "MODEL", "created_at": _iso(now - 300),
                    "model": "gemini-4-neon-high", "input_tokens": 1_000_000, "output_tokens": 100_000, "cache_read_tokens": 500_000,
                }),
            ]) + "\n",
            encoding="utf-8",
        )
        agy_child = t3_dir / "providers" / "antigravity" / "acct1" / "antigravity-acp" / "brain" / "44444444-4444-4444-4444-444444444444" / ".system_generated" / "logs" / "transcript.jsonl"
        agy_child.parent.mkdir(parents=True)
        agy_child.write_text(
            json.dumps({
                "step_index": 1, "source": "MODEL", "created_at": _iso(now - 250),
                "model": "gemini-4-neon-high", "input_tokens": 500_000, "output_tokens": 50_000, "cache_read_tokens": 0,
            }) + "\n",
            encoding="utf-8",
        )

        # 3. Claude delegate transcript + its subagent + a standalone CLI session matched by worktree cwd.
        claude_dir = home / ".claude" / "projects" / "conj"
        claude_dir.mkdir(parents=True)
        (claude_dir / "22222222-2222-2222-2222-222222222222.jsonl").write_text(
            "\n".join([
                # Streamed message with same id -> max values win once.
                json.dumps({
                    "type": "assistant", "timestamp": _iso(now - 200), "cwd": str(proj_conj),
                    "sessionId": "22222222-2222-2222-2222-222222222222",
                    "message": {"id": "msg_1", "model": "claude-opus-5-5", "usage": {
                        "input_tokens": 100_000, "output_tokens": 10_000, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0,
                    }},
                }),
                json.dumps({
                    "type": "assistant", "timestamp": _iso(now - 195), "cwd": str(proj_conj),
                    "sessionId": "22222222-2222-2222-2222-222222222222",
                    "message": {"id": "msg_1", "model": "claude-opus-5-5", "usage": {
                        "input_tokens": 200_000, "output_tokens": 100_000, "cache_read_input_tokens": 1_000_000, "cache_creation_input_tokens": 0,
                    }},
                }),
            ]) + "\n",
            encoding="utf-8",
        )
        claude_sub = claude_dir / "22222222-2222-2222-2222-222222222222" / "subagents" / "agent-abc.jsonl"
        claude_sub.parent.mkdir(parents=True)
        claude_sub.write_text(
            json.dumps({
                "type": "assistant", "timestamp": _iso(now - 180), "cwd": str(proj_conj),
                "message": {"id": "msg_sub", "model": "claude-haiku-5-5", "usage": {
                    "input_tokens": 1_000_000, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0,
                }},
            }) + "\n",
            encoding="utf-8",
        )
        # Standalone CLI session in silo worktree (older: 10 hours ago, so excluded from 1h/5h but included in 24h).
        (claude_dir / "55555555-5555-5555-5555-555555555555.jsonl").write_text(
            json.dumps({
                "type": "assistant", "timestamp": _iso(now - 10 * 3600),
                "cwd": str(root / ".t3" / "worktrees" / "prox" / "t3-feature-x"),
                "sessionId": "55555555-5555-5555-5555-555555555555",
                "message": {"id": "msg_cli", "model": "claude-sonnet-5-5", "usage": {
                    "input_tokens": 1_000_000, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0,
                }},
            }) + "\n",
            encoding="utf-8",
        )

        # 4. Codex delegate transcript (with cached_input_tokens subtracted from input_tokens).
        codex_dir = home / ".codex-silo" / "sessions" / "2026" / "11" / "24"
        codex_dir.mkdir(parents=True)
        (codex_dir / "rollout-2026-11-24T12-00-00-33333333-3333-3333-3333-333333333333.jsonl").write_text(
            "\n".join([
                json.dumps({"type": "session_meta", "payload": {"session_id": "33333333-3333-3333-3333-333333333333", "cwd": str(proj_conj)}}),
                json.dumps({"type": "turn_context", "payload": {"model": "gpt-6.2-sol"}}),
                json.dumps({
                    "type": "event_msg", "timestamp": _iso(now - 150),
                    "payload": {
                        "type": "token_count",
                        "info": {
                            "total_token_usage": {"input_tokens": 1_200_000, "output_tokens": 100_000, "total_tokens": 1_300_000},
                            "last_token_usage": {"input_tokens": 1_200_000, "cached_input_tokens": 1_000_000, "output_tokens": 100_000},
                        },
                    },
                }),
            ]) + "\n",
            encoding="utf-8",
        )

        # 5. Compressed .jsonl.zst Codex file backed by usage-scan-cache-v17.json.
        zst_file = codex_dir / "rollout-2026-11-24T11-00-00-66666666-6666-6666-6666-666666666666.jsonl.zst"
        zst_file.write_bytes(b"fake-zst")
        (t3_dir / "usage-scan-cache-v17.json").write_text(
            json.dumps({
                "version": 17,
                "models": ["gpt-6.2-sol"],
                "sessions": ["33333333-3333-3333-3333-333333333333"],
                "files": {
                    str(zst_file): {
                        "s": len(b"fake-zst"),
                        "p": "codex",
                        "r": [[int((now - 140) * 1000), 0, 0, 400_000, 0, 0, 0, 0, "k1"]],
                    }
                },
            }),
            encoding="utf-8",
        )

        # 6. OpenCode DB with unpriced Devin model on silo thread (child session rolls into parent).
        oc_db = home / ".local" / "share" / "opencode" / "opencode.db"
        oc_db.parent.mkdir(parents=True)
        oc = sqlite3.connect(oc_db)
        with oc:
            oc.execute("CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT)")
            oc.execute("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)")
            oc.executemany(
                "INSERT INTO session VALUES (?,?,?,?)",
                [
                    ("ses_devin_root", None, str(proj_silo), "Devin root"),
                    ("ses_devin_child", "ses_devin_root", str(proj_silo), "Devin child"),
                ],
            )
            oc.execute(
                "INSERT INTO message VALUES (?,?,?,?)",
                (
                    "msg_oc_1",
                    "ses_devin_child",
                    int((now - 100) * 1000),
                    json.dumps({
                        "role": "assistant",
                        "modelID": "devin/swe-2-flash",
                        "providerID": "silo",
                        "tokens": {"input": 50_000, "output": 10_000, "reasoning": 5_000, "cache": {"read": 20_000, "write": 0}},
                        "time": {"completed": int((now - 100) * 1000)},
                    }),
                ),
            )
        oc.close()
        return t3_dir, home, oc_db

    def test_project_and_thread_rollup_provider_filter_and_time_window(self):
        now = 1_795_500_000.0
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            t3_dir, home, oc_db = self._build_fixture(root, now)
            store = history_store.Store(root / "quota.sqlite")
            svc = usage_breakdown.UsageBreakdownService(scan_ttl=30)

            res = svc.breakdown(store, hours=24, provider="all", now=now, t3_dir=t3_dir, usage_home=home, opencode_db=oc_db, sync=True)
            self.assertTrue(res["available"])
            # 2 projects: conjectures and silo
            self.assertEqual([p["title"] for p in res["projects"]], ["conjectures", "silo"])

            conj = res["projects"][0]
            # Antigravity parent: (1M*3 + 0.1M*15 + 0.5M*0.3) = 4.65
            # Antigravity child:  (0.5M*3 + 0.05M*15) = 2.25 -> agy total = 6.90
            # Claude delegate: (0.2M*5 + 0.1M*25 + 1M*0.5) = 4.00; Claude subagent: (1M*1) = 1.00 -> claude total = 5.00
            # Codex delegate: (0.2M*2.5 + 0.1M*15 + 1M*0.25) = 2.25; zst cached: (0.4M*2.5) = 1.00 -> codex total = 3.25
            # Total conjectures = 15.15
            self.assertAlmostEqual(conj["cost_usd"], 15.15, places=3)
            self.assertAlmostEqual(conj["providers"]["antigravity"]["cost_usd"], 6.90, places=3)
            self.assertAlmostEqual(conj["providers"]["claude"]["cost_usd"], 5.00, places=3)
            self.assertAlmostEqual(conj["providers"]["codex"]["cost_usd"], 3.25, places=3)
            self.assertEqual(conj["thread_count"], 1)
            self.assertEqual(conj["threads"][0]["title"], "Prove Theorem 42")
            # Subagents rolled into root thread: t-del-claude, t-del-codex, native agy child 4444..., (claude subagent shares t-del-claude)
            self.assertGreaterEqual(conj["threads"][0]["subagent_count"], 3)

            silo = res["projects"][1]
            # Standalone CLI claude-sonnet-5-5: 1M * 3 = 3.00; Devin unpriced: 85,000 tokens
            self.assertAlmostEqual(silo["cost_usd"], 3.00, places=3)
            self.assertEqual(silo["providers"]["devin"]["tokens"], 85_000)
            self.assertEqual(silo["thread_count"], 2)

            # Provider filter: claude only -> conjectures=$5.00, silo=$3.00
            res_claude = svc.breakdown(store, hours=24, provider="claude", now=now, t3_dir=t3_dir, usage_home=home, opencode_db=oc_db)
            self.assertEqual([p["title"] for p in res_claude["projects"]], ["conjectures", "silo"])
            self.assertAlmostEqual(res_claude["projects"][0]["cost_usd"], 5.00, places=3)
            self.assertAlmostEqual(res_claude["projects"][1]["cost_usd"], 3.00, places=3)

            # Time window: 5h excludes the 10h-old silo CLI session!
            res_5h = svc.breakdown(store, hours=5, provider="claude", now=now, t3_dir=t3_dir, usage_home=home, opencode_db=oc_db)
            self.assertEqual([p["title"] for p in res_5h["projects"]], ["conjectures"])
            self.assertAlmostEqual(res_5h["projects"][0]["cost_usd"], 5.00, places=3)

            # Provider filter: devin (unpriced) -> share falls back to tokens cleanly.
            res_devin = svc.breakdown(store, hours=24, provider="devin", now=now, t3_dir=t3_dir, usage_home=home, opencode_db=oc_db)
            self.assertEqual(len(res_devin["projects"]), 1)
            self.assertEqual(res_devin["projects"][0]["title"], "silo")
            self.assertEqual(res_devin["projects"][0]["share"], 1.0)
            self.assertFalse(res_devin["projects"][0]["priced"])
            self.assertEqual(res_devin["projects"][0]["tokens"], 85_000)

    def test_unavailable_when_no_local_sources_or_disabled(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            store = history_store.Store(root / "quota.sqlite")
            svc = usage_breakdown.UsageBreakdownService()
            res = svc.breakdown(
                store, hours=24, provider="all",
                t3_dir=root / "missing-t3", usage_home=root / "missing-home", opencode_db=root / "missing.db",
                sync=True,
            )
            self.assertFalse(res["available"])
            self.assertEqual(res["projects"], [])

            with patch.dict(os.environ, {"DASHBOARD_USAGE_BREAKDOWN": "0"}):
                res2 = svc.breakdown(store, hours=24, provider="all", sync=True)
                self.assertFalse(res2["available"])

    def test_http_route_requires_auth_validates_params_and_returns_breakdown(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            creds = root / "credentials.json"
            creds.write_text(json.dumps({"management_key": "test-mgmt-key"}), encoding="utf-8")
            hub = dashboard_server.Hub(history_store.Store(root / "quota.sqlite"))
            srv = dashboard_server.ThreadingHTTPServer(("127.0.0.1", 0), dashboard_server.Handler)
            srv.hub = hub
            port = srv.server_address[1]
            thread = threading.Thread(target=srv.serve_forever, daemon=True)
            thread.start()
            try:
                with patch.object(dashboard_server, "CREDENTIALS", creds), \
                     patch.object(dashboard_server, "LOCAL_HOSTS", {f"127.0.0.1:{port}"}), \
                     patch.object(hub.usage_breakdown, "breakdown", return_value={"available": True, "hours": 5, "provider": "claude", "projects": [], "threads": [], "totals": {"requests": 0}}) as mock_bd:
                    # Unauthenticated -> 401
                    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                    c.request("GET", "/dashboard/api/usage/breakdown?hours=5&provider=claude")
                    r = c.getresponse()
                    r.read()
                    self.assertEqual(r.status, 401)
                    c.close()

                    # Login
                    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                    c.request("POST", "/dashboard/api/login", json.dumps({"key": "test-mgmt-key"}),
                              {"Content-Type": "application/json", "X-Dashboard-Request": "1"})
                    r = c.getresponse()
                    r.read()
                    cookie = r.getheader("Set-Cookie").split(";", 1)[0]
                    self.assertEqual(r.status, 200)

                    # Valid request
                    c.request("GET", "/dashboard/api/usage/breakdown?hours=5&provider=claude", headers={"Cookie": cookie})
                    r = c.getresponse()
                    body = json.loads(r.read())
                    self.assertEqual(r.status, 200)
                    self.assertEqual(body["hours"], 5)
                    self.assertEqual(body["provider"], "claude")
                    mock_bd.assert_called_once_with(hub.store, hours=5, provider="claude")

                    # Invalid provider -> 400
                    c.request("GET", "/dashboard/api/usage/breakdown?hours=24&provider=../bad", headers={"Cookie": cookie})
                    r = c.getresponse()
                    r.read()
                    self.assertEqual(r.status, 400)

                    # Invalid hours -> 400
                    c.request("GET", "/dashboard/api/usage/breakdown?hours=abc", headers={"Cookie": cookie})
                    r = c.getresponse()
                    r.read()
                    self.assertEqual(r.status, 400)
                    c.close()
            finally:
                srv.shutdown()
                srv.server_close()


if __name__ == "__main__":
    unittest.main()
