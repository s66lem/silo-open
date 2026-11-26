"""Per-project and per-thread usage attribution for Quota management.

Reads local T3 Code metadata (statev2.sqlite) alongside local CLI/provider transcripts
(Claude Code, Codex, Antigravity, OpenCode) in read-only mode, caches 15-minute per-file
aggregates in the dashboard SQLite store so incremental refreshes stay fast, and rolls up
subagents and delegated tasks into their root T3 threads and projects.
"""
from datetime import datetime
import json
import os
from pathlib import Path
import re
import sqlite3
import threading
import time

from api_pricing import uncached_api_cost

BUCKET_SECONDS = 900  # 15-minute buckets: accurate for 1h/5h/24h/7d/14d while compact
RETENTION_SECONDS = 15 * 86400  # covers max 14d chart range with 1d buffer
SCAN_TTL = 30.0  # re-scan modified transcript files at most every 30s
MAX_PROJECTS = 50
MAX_THREADS = 80
MAX_PROJECT_THREADS = 25

_UUID_RE = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I)
_CODEX_SID_RE = re.compile(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$", re.I)
_CACHE_VER_RE = re.compile(r"^usage-scan-cache-v(\d+)\.json$")
_AGY_CONV_RE = re.compile(
    r'\\*"conversationId\\*"\s*[:=]\s*\\*"([0-9a-f-]{36})\\*"|conversation://([0-9a-f-]{36})',
    re.I,
)
_CLAUDE_SUBAGENT_RE = re.compile(r"^agent-", re.I)


def _iso_ts(value):
    if not value:
        return None
    if isinstance(value, (int, float)):
        return float(value) / 1000.0 if value > 1e12 else float(value)
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _norm_path(path):
    text = str(path or "").strip().replace("\\", "/")
    while len(text) > 1 and text.endswith("/"):
        text = text[:-1]
    return text.lower()


def _path_tail(path):
    norm = str(path or "").strip().replace("\\", "/").rstrip("/")
    if not norm:
        return ""
    return norm.rsplit("/", 1)[-1]


def canonical_provider(provider_hint="", model=""):
    """Map T3 provider instances, drivers, or model names to dashboard provider ids."""
    m = str(model or "").strip().lower()
    if m:
        if m.startswith(("claude", "anthropic/")):
            return "claude"
        if m.startswith(("devin/", "swe-")):
            return "devin"
        if m.startswith(("grok", "xai/")):
            return "xai"
        if m.startswith(("gemini", "google/", "antigravity/")):
            return "antigravity"
        if m.startswith(("gpt-", "o1", "o3", "o4", "codex", "openai/")):
            return "codex"
        if m.startswith(("kimi", "moonshot/")):
            return "kimi"
    p = str(provider_hint or "").strip().lower()
    if not p:
        return "other"
    if p.startswith("claude") or "anthropic" in p:
        return "claude"
    if p.startswith("codex") or "openai" in p:
        return "codex"
    if p.startswith(("antigravity", "agy")) or "gemini" in p:
        return "antigravity"
    if p.startswith("devin"):
        return "devin"
    if p.startswith(("grok", "xai")):
        return "xai"
    if p.startswith("kimi"):
        return "kimi"
    if p.startswith("meta"):
        return "meta"
    return p


def _open_ro_sqlite(path):
    """Open an existing SQLite database read-only without modifying WAL/SHM files."""
    uri = f"file:{Path(path).resolve().as_posix()}?mode=ro"
    return sqlite3.connect(uri, uri=True, timeout=5)


def load_t3_metadata(t3_dir):
    """Load projects, threads (with root lineage), nativeId->thread links, and path matchers."""
    empty = {
        "has_db": False,
        "projects": {},
        "threads": {},
        "native_to_thread": {},
        "path_to_project": [],
        "worktree_name_to_project": {},
    }
    db_path = Path(t3_dir) / "statev2.sqlite"
    if not db_path.is_file():
        return empty
    try:
        con = _open_ro_sqlite(db_path)
    except sqlite3.Error:
        return empty
    try:
        projects = {}
        path_pairs = []
        wt_names = {}
        try:
            rows = con.execute(
                "SELECT project_id, title, workspace_root, deleted_at FROM projection_projects"
            ).fetchall()
        except sqlite3.Error:
            rows = []
        for pid, title, root, deleted_at in rows:
            pid = str(pid or "")
            title = str(title or "").strip() or _path_tail(root) or pid
            root_str = str(root or "").strip()
            projects[pid] = {
                "id": pid,
                "title": title,
                "workspace_root": root_str,
                "deleted": deleted_at is not None,
            }
            if root_str and deleted_at is None:
                norm = _norm_path(root_str)
                if norm:
                    path_pairs.append((norm, pid))
                    tail = _path_tail(root_str).lower()
                    if tail and tail not in wt_names:
                        wt_names[tail] = pid

        threads = {}
        try:
            t_rows = con.execute(
                "SELECT thread_id, project_id, title, default_provider, updated_at, archived_at, deleted_at, payload_json "
                "FROM orchestration_v2_projection_threads"
            ).fetchall()
        except sqlite3.Error:
            t_rows = []
        for tid, pid, title, prov, updated_at, archived_at, deleted_at, payload_json in t_rows:
            tid = str(tid or "")
            pid = str(pid or "")
            try:
                payload = json.loads(payload_json) if payload_json else {}
            except ValueError:
                payload = {}
            lineage = payload.get("lineage") if isinstance(payload, dict) else None
            lineage = lineage if isinstance(lineage, dict) else {}
            root_tid = str(lineage.get("rootThreadId") or "") or tid
            parent_tid = str(lineage.get("parentThreadId") or "") or None
            wt_path = str(payload.get("worktreePath") or "").strip() if isinstance(payload, dict) else ""
            if wt_path and pid:
                norm_wt = _norm_path(wt_path)
                if norm_wt:
                    path_pairs.append((norm_wt, pid))
            threads[tid] = {
                "id": tid,
                "project_id": pid,
                "title": str(title or "").strip() or "Untitled thread",
                "provider": canonical_provider(prov),
                "updated_at": _iso_ts(updated_at),
                "archived": archived_at is not None,
                "deleted": deleted_at is not None,
                "root_thread_id": root_tid,
                "parent_thread_id": parent_tid,
                "is_subagent": bool(root_tid and root_tid != tid),
            }

        # Resolve multi-hop parent chains cleanly so root_thread_id always lands on the top ancestor.
        for tid, info in threads.items():
            cur = info["root_thread_id"]
            seen = {tid}
            while cur in threads and cur not in seen:
                seen.add(cur)
                nxt = threads[cur]["root_thread_id"]
                if not nxt or nxt == cur:
                    break
                cur = nxt
            info["root_thread_id"] = cur
            info["is_subagent"] = cur != tid

        native_to_thread = {}
        try:
            pt_rows = con.execute(
                "SELECT provider, driver, provider_instance_id, thread_id, payload_json "
                "FROM orchestration_v2_projection_provider_threads"
            ).fetchall()
        except sqlite3.Error:
            pt_rows = []
        for prov, driver, inst, tid, payload_json in pt_rows:
            if not tid:
                continue
            try:
                payload = json.loads(payload_json) if payload_json else {}
            except ValueError:
                continue
            ntr = payload.get("nativeThreadRef") if isinstance(payload, dict) else None
            nid = str((ntr or {}).get("nativeId") or "").strip() if isinstance(ntr, dict) else ""
            if not nid or nid.startswith("pending:"):
                continue
            cprov = canonical_provider(inst or prov or driver)
            native_to_thread[nid] = (str(tid), cprov)

        # Longest prefix match first so nested projects (e.g. workspace/coms-hw1 vs workspace) win cleanly.
        dedup_paths = {}
        for norm, pid in path_pairs:
            dedup_paths.setdefault(norm, pid)
        sorted_paths = sorted(dedup_paths.items(), key=lambda item: len(item[0]), reverse=True)
        return {
            "has_db": True,
            "projects": projects,
            "threads": threads,
            "native_to_thread": native_to_thread,
            "path_to_project": sorted_paths,
            "worktree_name_to_project": wt_names,
        }
    finally:
        con.close()


def _find_usage_scan_cache(t3_dir):
    t3_dir = Path(t3_dir)
    if not t3_dir.is_dir():
        return None
    best = None
    for entry in t3_dir.iterdir():
        if not entry.is_file():
            continue
        m = _CACHE_VER_RE.fullmatch(entry.name)
        if m:
            ver = int(m.group(1))
            if best is None or ver > best[0]:
                best = (ver, entry)
    return best[1] if best else None


def _peek_jsonl_meta(path, limit_bytes=65536):
    """Quickly read session_id and cwd from the head of a Claude or Codex JSONL file."""
    sid, cwd = "", ""
    try:
        with open(path, "rb") as fh:
            chunk = fh.read(limit_bytes)
    except OSError:
        return sid, cwd
    for raw in chunk.splitlines():
        if not raw or (b'"cwd"' not in raw and b'"sessionId"' not in raw and b'"session_meta"' not in raw):
            continue
        try:
            row = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(row, dict):
            continue
        if not sid and isinstance(row.get("sessionId"), str):
            sid = row["sessionId"].strip()
        if not cwd and isinstance(row.get("cwd"), str):
            cwd = row["cwd"].strip()
        payload = row.get("payload")
        if isinstance(payload, dict):
            if not sid:
                sval = payload.get("session_id") or payload.get("id")
                if isinstance(sval, str):
                    sid = sval.strip()
            if not cwd and isinstance(payload.get("cwd"), str):
                cwd = payload["cwd"].strip()
        if sid and cwd:
            break
    return sid, cwd


def _add_bucket(buckets, ts, provider, model, uncached_in, outp, cache_read, cache_write):
    bts = int(ts // BUCKET_SECONDS) * BUCKET_SECONDS
    key = (bts, provider, model)
    slot = buckets.get(key)
    if slot is None:
        buckets[key] = [1, uncached_in, outp, cache_read, cache_write]
    else:
        slot[0] += 1
        slot[1] += uncached_in
        slot[2] += outp
        slot[3] += cache_read
        slot[4] += cache_write


def _buckets_to_rows(buckets):
    return [
        (bts, prov, model, v[0], v[1], v[2], v[3], v[4])
        for (bts, prov, model), v in buckets.items()
    ]


def _claude_session_from_path(path):
    """Return (session_id, parent_session_id) inferred from Claude Code's project layout."""
    p = Path(path)
    parts = p.parts
    if len(parts) >= 3 and parts[-2] == "subagents":
        parent = parts[-3]
        return parent, parent
    stem = p.stem
    if _UUID_RE.fullmatch(stem):
        return stem, ""
    return stem, ""


def parse_claude_jsonl(path, cutoff):
    """Parse one Claude Code transcript into 15-minute buckets with message-id deduplication."""
    best = {}
    sid, parent_sid = _claude_session_from_path(path)
    cwd = ""
    try:
        with open(path, "rb") as fh:
            for raw in fh:
                if not cwd and b'"cwd"' in raw:
                    try:
                        row = json.loads(raw)
                        if isinstance(row.get("cwd"), str) and row["cwd"].strip():
                            cwd = row["cwd"].strip()
                        if not parent_sid and isinstance(row.get("sessionId"), str) and row["sessionId"].strip():
                            sid = row["sessionId"].strip()
                    except ValueError:
                        pass
                if b'"usage"' not in raw or b'"assistant"' not in raw:
                    continue
                try:
                    row = json.loads(raw)
                except ValueError:
                    continue
                if not cwd and isinstance(row.get("cwd"), str) and row["cwd"].strip():
                    cwd = row["cwd"].strip()
                if not parent_sid and isinstance(row.get("sessionId"), str) and row["sessionId"].strip():
                    sid = row["sessionId"].strip()
                msg = row.get("message")
                if row.get("type") != "assistant" or not isinstance(msg, dict) or not isinstance(msg.get("usage"), dict):
                    continue
                mid = msg.get("id")
                model = str(msg.get("model") or "").strip()
                ts = _iso_ts(row.get("timestamp"))
                if not mid or ts is None or ts < cutoff or model.startswith("<"):
                    continue
                u = msg["usage"]
                vals = (
                    int(u.get("input_tokens") or 0),
                    int(u.get("output_tokens") or 0),
                    int(u.get("cache_read_input_tokens") or 0),
                    int(u.get("cache_creation_input_tokens") or 0),
                )
                cur = best.get(mid)
                if cur is not None:
                    vals = tuple(max(a, b) for a, b in zip(vals, cur[2]))
                    ts = min(ts, cur[0])
                best[mid] = (ts, model or "claude", vals)
    except OSError:
        return sid, cwd, parent_sid, []

    buckets = {}
    for ts, model, (inp, outp, read, write) in best.values():
        prov = canonical_provider("claude", model)
        _add_bucket(buckets, ts, prov, model, inp, outp, read, write)
    return sid, cwd, parent_sid, _buckets_to_rows(buckets)


def parse_codex_jsonl(path, cutoff):
    """Parse one Codex session JSONL file into 15-minute buckets."""
    sid, cwd, model = "", "", ""
    m = _CODEX_SID_RE.search(Path(path).name)
    if m:
        sid = m.group(1)
    seen = set()
    buckets = {}
    try:
        with open(path, "rb") as fh:
            for raw in fh:
                if b'"session_meta"' in raw:
                    try:
                        payload = (json.loads(raw).get("payload") or {})
                        sval = payload.get("session_id") or payload.get("id")
                        if isinstance(sval, str) and sval.strip():
                            sid = sval.strip()
                        if isinstance(payload.get("cwd"), str) and payload["cwd"].strip():
                            cwd = payload["cwd"].strip()
                    except ValueError:
                        pass
                    continue
                if b'"turn_context"' in raw:
                    try:
                        payload = (json.loads(raw).get("payload") or {})
                        if payload.get("model"):
                            model = str(payload["model"]).strip()
                        if not cwd and isinstance(payload.get("cwd"), str) and payload["cwd"].strip():
                            cwd = payload["cwd"].strip()
                    except ValueError:
                        pass
                    continue
                if b'"token_count"' not in raw:
                    continue
                try:
                    row = json.loads(raw)
                except ValueError:
                    continue
                p = row.get("payload") or {}
                ts = _iso_ts(row.get("timestamp"))
                if row.get("type") != "event_msg" or p.get("type") != "token_count" or ts is None or ts < cutoff:
                    continue
                info = p.get("info") or {}
                total, last = info.get("total_token_usage"), info.get("last_token_usage")
                if not isinstance(total, dict) or not isinstance(last, dict):
                    continue
                key = (row.get("timestamp"), total.get("input_tokens"), total.get("output_tokens"), total.get("total_tokens"))
                if key in seen:
                    continue
                seen.add(key)
                inp_total = int(last.get("input_tokens") or 0)
                cached = int(last.get("cached_input_tokens") or 0)
                uncached_in = max(0, inp_total - cached)
                outp = int(last.get("output_tokens") or 0)
                write = int(last.get("cache_write_input_tokens") or 0)
                use_model = model or "codex"
                _add_bucket(buckets, ts, canonical_provider("codex", use_model), use_model, uncached_in, outp, cached, write)
    except OSError:
        return sid, cwd, "", []
    return sid, cwd, "", _buckets_to_rows(buckets)


def parse_antigravity_transcript(path, cutoff):
    """Parse one Antigravity transcript into 15-minute buckets and child subagent conversation IDs."""
    conv_id = Path(path).parent.parent.parent.name
    steps = set()
    child_ids = set()
    buckets = {}
    try:
        with open(path, "rb") as fh:
            for raw in fh:
                if b"invoke_subagent" in raw or b"conversationId" in raw or b"conversation://" in raw:
                    text = raw.decode("utf-8", "ignore")
                    for match in _AGY_CONV_RE.finditer(text):
                        cid = (match.group(1) or match.group(2) or "").lower()
                        if cid and cid != conv_id.lower():
                            child_ids.add(cid)
                if b'"input_tokens"' not in raw:
                    continue
                try:
                    row = json.loads(raw)
                except ValueError:
                    continue
                ts = _iso_ts(row.get("created_at"))
                if row.get("source") != "MODEL" or ts is None or ts < cutoff:
                    continue
                step = row.get("step_index")
                if step in steps:
                    continue
                steps.add(step)
                model = str(row.get("model") or "antigravity").strip()
                # Antigravity reports input_tokens already excluding cache_read_tokens.
                uncached_in = int(row.get("input_tokens") or 0)
                outp = int(row.get("output_tokens") or 0)
                read = int(row.get("cache_read_tokens") or 0)
                _add_bucket(buckets, ts, canonical_provider("antigravity", model), model, uncached_in, outp, read, 0)
    except OSError:
        return conv_id, child_ids, []
    return conv_id, child_ids, _buckets_to_rows(buckets)


def parse_from_usage_cache(cache_entry, models, sessions, provider_hint, path, cutoff):
    """Convert a matching usage-scan-cache entry into canonical 15-minute buckets."""
    buckets = {}
    session_id = ""
    recs = cache_entry.get("r") or ()
    for rec in recs:
        if not isinstance(rec, list) or len(rec) < 7:
            continue
        ts = _iso_ts(rec[0])
        if ts is None or ts < cutoff:
            continue
        m_idx, s_idx = rec[1], rec[2]
        model = models[m_idx] if isinstance(m_idx, int) and 0 <= m_idx < len(models) else provider_hint
        if not session_id and isinstance(s_idx, int) and 0 <= s_idx < len(sessions):
            session_id = str(sessions[s_idx] or "")
        uncached_in = int(rec[3] or 0)
        cache_read = int(rec[4] or 0)
        cache_write = int(rec[5] or 0)
        outp = int(rec[6] or 0)
        prov = canonical_provider(provider_hint, model)
        _add_bucket(buckets, ts, prov, str(model or provider_hint), uncached_in, outp, cache_read, cache_write)
    if provider_hint == "claude":
        path_sid, parent_sid = _claude_session_from_path(path)
        sid = parent_sid or session_id or path_sid
    else:
        m = _CODEX_SID_RE.search(Path(path).name)
        sid = session_id or (m.group(1) if m else Path(path).stem)
        parent_sid = ""
    cwd = ""
    if not str(path).endswith(".zst"):
        peek_sid, peek_cwd = _peek_jsonl_meta(path)
        cwd = peek_cwd
        if not sid and peek_sid:
            sid = peek_sid
    return sid, cwd, parent_sid, _buckets_to_rows(buckets)


def read_opencode_usage(opencode_db, cutoff):
    """Read recent OpenCode assistant messages directly from opencode.db (read-only)."""
    db_path = Path(opencode_db)
    if not db_path.is_file():
        return []
    try:
        con = _open_ro_sqlite(db_path)
    except sqlite3.Error:
        return []
    try:
        sessions = {}
        for sid, parent_id, directory, title in con.execute(
            "SELECT id, parent_id, directory, title FROM session"
        ):
            sessions[str(sid)] = {
                "parent_id": str(parent_id) if parent_id else "",
                "cwd": str(directory or "").strip(),
                "title": str(title or "").strip(),
            }

        def root_session(sid):
            cur = sid
            seen = {cur}
            while cur in sessions:
                parent = sessions[cur]["parent_id"]
                if not parent or parent in seen:
                    break
                seen.add(parent)
                cur = parent
            return cur

        cutoff_ms = int(cutoff * 1000)
        by_session = {}
        rows = con.execute(
            "SELECT session_id, time_created, data FROM message WHERE time_created >= ?",
            (cutoff_ms,),
        ).fetchall()
        for sid, tc_ms, raw_data in rows:
            if not raw_data or '"assistant"' not in raw_data:
                continue
            try:
                data = json.loads(raw_data)
            except ValueError:
                continue
            if not isinstance(data, dict) or data.get("role") != "assistant":
                continue
            tokens = data.get("tokens")
            if not isinstance(tokens, dict):
                continue
            inp = int(tokens.get("input") or 0)
            outp = int(tokens.get("output") or 0) + int(tokens.get("reasoning") or 0)
            cache = tokens.get("cache") if isinstance(tokens.get("cache"), dict) else {}
            read = int(cache.get("read") or 0)
            write = int(cache.get("write") or 0)
            if inp + outp + read + write <= 0:
                continue
            ts = _iso_ts((data.get("time") or {}).get("completed") or tc_ms)
            if ts is None or ts < cutoff:
                continue
            model = str(data.get("modelID") or "").strip() or "opencode"
            prov = canonical_provider(data.get("providerID") or "", model)
            sid_str = str(sid)
            buckets = by_session.setdefault(sid_str, {})
            _add_bucket(buckets, ts, prov, model, inp, outp, read, write)

        out = []
        for sid, buckets in by_session.items():
            meta = sessions.get(sid) or {}
            root_sid = root_session(sid)
            parent_sid = root_sid if root_sid != sid else ""
            out.append({
                "session_id": sid,
                "parent_session_id": parent_sid,
                "cwd": meta.get("cwd") or (sessions.get(root_sid) or {}).get("cwd") or "",
                "title": meta.get("title") or (sessions.get(root_sid) or {}).get("title") or "",
                "buckets": _buckets_to_rows(buckets),
            })
        return out
    except sqlite3.Error:
        return []
    finally:
        con.close()


def _discover_transcript_files(t3_dir, usage_home, cutoff):
    """Return [(source, path, stat_result)] for recently modified Claude, Codex, and Antigravity files."""
    files = []
    home = Path(usage_home)
    t3 = Path(t3_dir)

    if home.is_dir():
        for claude_home in sorted(home.glob(".claude*")):
            proj_dir = claude_home / "projects"
            if not proj_dir.is_dir():
                continue
            for p in proj_dir.rglob("*.jsonl"):
                try:
                    st = p.stat()
                except OSError:
                    continue
                if st.st_mtime >= cutoff:
                    files.append(("claude", p, st))
        for codex_home in sorted(home.glob(".codex*")):
            if not codex_home.is_dir():
                continue
            for sub in ("sessions", "archived_sessions"):
                sdir = codex_home / sub
                if not sdir.is_dir():
                    continue
                for p in sdir.rglob("*.jsonl*"):
                    if not (p.name.endswith(".jsonl") or p.name.endswith(".jsonl.zst")):
                        continue
                    try:
                        st = p.stat()
                    except OSError:
                        continue
                    if st.st_mtime >= cutoff:
                        files.append(("codex", p, st))

    agy_root = t3 / "providers" / "antigravity"
    if agy_root.is_dir():
        for p in agy_root.glob("*/antigravity-acp/brain/*/.system_generated/logs/transcript.jsonl"):
            try:
                st = p.stat()
            except OSError:
                continue
            if st.st_mtime >= cutoff:
                files.append(("antigravity", p, st))

    return files


def _match_project_by_cwd(cwd, meta):
    """Best-effort project match from a session's working directory."""
    if not cwd:
        return None
    norm = _norm_path(cwd)
    if not norm:
        return None
    for prefix, pid in meta["path_to_project"]:
        if norm == prefix or norm.startswith(prefix + "/"):
            return pid
    # Match T3 worktree paths like .../.t3/worktrees/<project-folder>/<worktree-id>
    m = re.search(r"/\.t3/worktrees/([^/]+)(?:/|$)", norm)
    if m:
        wt_key = m.group(1).lower()
        if wt_key in meta["worktree_name_to_project"]:
            return meta["worktree_name_to_project"][wt_key]
    return None


def _empty_metrics():
    return {
        "cost_usd": 0.0,
        "priced_tokens": 0,
        "unpriced_tokens": 0,
        "tokens": 0,
        "io_tokens": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "requests": 0,
        "last_active_at": 0,
        "providers": {},
        "models": {},
    }


def _add_metrics(target, prov, model, bts, reqs, inp, outp, read, write, cost):
    total = inp + outp + read + write
    target["requests"] += reqs
    target["input_tokens"] += inp
    target["output_tokens"] += outp
    target["cache_read_tokens"] += read
    target["cache_write_tokens"] += write
    target["io_tokens"] += inp + outp
    target["tokens"] += total
    if bts > target["last_active_at"]:
        target["last_active_at"] = bts
    if cost is not None:
        target["cost_usd"] += cost
        target["priced_tokens"] += total
    else:
        target["unpriced_tokens"] += total
    pslot = target["providers"].get(prov)
    if pslot is None:
        pslot = target["providers"][prov] = {"cost_usd": 0.0, "tokens": 0, "io_tokens": 0, "requests": 0}
    pslot["requests"] += reqs
    pslot["tokens"] += total
    pslot["io_tokens"] += inp + outp
    if cost is not None:
        pslot["cost_usd"] += cost
    if model:
        mslot = target["models"].get(model)
        if mslot is None:
            mslot = target["models"][model] = [0.0, 0]
        if cost is not None:
            mslot[0] += cost
        mslot[1] += total


def _finalize_providers(providers):
    return {
        p: {
            "cost_usd": round(v["cost_usd"], 4),
            "tokens": int(v["tokens"]),
            "io_tokens": int(v["io_tokens"]),
            "requests": int(v["requests"]),
        }
        for p, v in sorted(providers.items(), key=lambda kv: (-kv[1]["cost_usd"], -kv[1]["tokens"], kv[0]))
    }


def _top_models(models, limit=4):
    ranked = sorted(models.items(), key=lambda kv: (-kv[1][0], -kv[1][1], kv[0]))
    return [name for name, _ in ranked[:limit]]


class UsageBreakdownService:
    """TTL-cached local usage scanner + aggregator backed by the dashboard SQLite store."""

    def __init__(self, scan_ttl=SCAN_TTL):
        self.scan_ttl = scan_ttl
        self.lock = threading.Lock()
        self.last_scan_at = 0.0
        self.meta_at = 0.0
        self.meta = None
        self.agy_parents = {}  # child_conv_id -> parent_conv_id
        self.opencode_at = 0.0
        self.opencode_sig = None
        self.opencode_records = []
        self._scan_in_progress = False
        self._has_any_source = None

    @staticmethod
    def _default_paths(t3_dir=None, usage_home=None, opencode_db=None):
        home = Path(usage_home or os.environ.get("DASHBOARD_USAGE_HOME") or str(Path.home()))
        t3 = Path(t3_dir or os.environ.get("DASHBOARD_T3_DATA") or str(home / ".t3" / "userdata"))
        oc = Path(opencode_db or os.environ.get("DASHBOARD_OPENCODE_DB") or str(home / ".local" / "share" / "opencode" / "opencode.db"))
        return t3, home, oc

    def _scan_files_into_store(self, store, t3_dir, usage_home, now):
        cutoff = now - RETENTION_SECONDS
        discovered = _discover_transcript_files(t3_dir, usage_home, cutoff)
        cached_states = store.usage_file_states()

        # Check which files need scanning.
        pending = []
        live_paths = []
        for source, path, st in discovered:
            key = str(path)
            live_paths.append(key)
            prev = cached_states.get(key)
            if prev and prev["mtime_ns"] == st.st_mtime_ns and prev["size"] == st.st_size:
                continue
            pending.append((source, path, st))

        # Lazily load T3's usage-scan-cache only if we have pending Claude/Codex files.
        usage_cache = None
        cache_files = {}
        cache_models = []
        cache_sessions = []
        if any(src in ("claude", "codex") for src, _, _ in pending):
            cache_path = _find_usage_scan_cache(t3_dir)
            if cache_path is not None:
                try:
                    usage_cache = json.loads(cache_path.read_text(encoding="utf-8"))
                    cache_files = usage_cache.get("files") or {}
                    cache_models = usage_cache.get("models") or []
                    cache_sessions = usage_cache.get("sessions") or []
                except (OSError, ValueError):
                    usage_cache = None

        # Normalize cache lookup keys for case-insensitive Windows paths.
        cache_by_norm = {}
        if cache_files:
            for k, v in cache_files.items():
                cache_by_norm[_norm_path(k)] = v

        to_save = []
        new_agy_parents = {}
        for source, path, st in pending:
            key = str(path)
            if source in ("claude", "codex"):
                ce = cache_by_norm.get(_norm_path(key))
                use_cache = (
                    isinstance(ce, dict)
                    and (ce.get("s") == st.st_size or key.endswith(".zst"))
                    and isinstance(ce.get("r"), list)
                )
                if use_cache:
                    sid, cwd, parent_sid, buckets = parse_from_usage_cache(
                        ce, cache_models, cache_sessions, source, key, cutoff
                    )
                elif key.endswith(".zst"):
                    # Stdlib cannot decompress zstd without a matching usage-scan-cache entry.
                    sid, cwd, parent_sid, buckets = "", "", "", []
                elif source == "claude":
                    sid, cwd, parent_sid, buckets = parse_claude_jsonl(path, cutoff)
                else:
                    sid, cwd, parent_sid, buckets = parse_codex_jsonl(path, cutoff)
                to_save.append({
                    "path": key,
                    "mtime_ns": st.st_mtime_ns,
                    "size": st.st_size,
                    "source": source,
                    "session_id": sid,
                    "cwd": cwd,
                    "parent_session_id": parent_sid,
                    "scanned_at": now,
                    "buckets": buckets,
                })
            elif source == "antigravity":
                conv_id, child_ids, buckets = parse_antigravity_transcript(path, cutoff)
                for cid in child_ids:
                    new_agy_parents[cid] = conv_id
                to_save.append({
                    "path": key,
                    "mtime_ns": st.st_mtime_ns,
                    "size": st.st_size,
                    "source": "antigravity",
                    "session_id": conv_id,
                    "cwd": "",
                    "parent_session_id": "",
                    "scanned_at": now,
                    "buckets": buckets,
                })

        if to_save:
            # Propagate newly discovered Antigravity subagent parent links onto child rows so
            # subsequent runs never have to re-read unchanged transcripts.
            if new_agy_parents:
                self.agy_parents.update(new_agy_parents)
            for rec in to_save:
                if rec["source"] == "antigravity" and not rec["parent_session_id"]:
                    p_conv = self.agy_parents.get(rec["session_id"].lower())
                    if p_conv:
                        rec["parent_session_id"] = p_conv
            store.save_usage_files(to_save)
            if new_agy_parents:
                store.update_usage_file_parents(new_agy_parents)
        elif new_agy_parents:
            self.agy_parents.update(new_agy_parents)
            store.update_usage_file_parents(new_agy_parents)
        store.prune_usage_files(live_paths, int(cutoff // BUCKET_SECONDS) * BUCKET_SECONDS)
        return bool(discovered)

    def refresh_now(self, store, now=None, t3_dir=None, usage_home=None, opencode_db=None):
        """Run one incremental scan into SQLite. Safe to call from a background warmup thread."""
        if os.environ.get("DASHBOARD_USAGE_BREAKDOWN") == "0":
            return False
        now = float(time.time() if now is None else now)
        t3, home, oc = self._default_paths(t3_dir, usage_home, opencode_db)
        with self.lock:
            self.meta = load_t3_metadata(t3)
            self.meta_at = now
            has_files = self._scan_files_into_store(store, t3, home, now)
            has_oc = self._refresh_opencode(oc, now)
            self.last_scan_at = now
            self._has_any_source = bool(self.meta["has_db"] or has_files or has_oc)
            return self._has_any_source

    def warm_loop(self, store, interval=60.0):
        """Background daemon loop that keeps SQLite usage buckets warm for instant HTTP replies."""
        while True:
            try:
                self.refresh_now(store)
            except Exception:
                pass
            time.sleep(interval)

    def _trigger_async_refresh(self, store, t3, home, oc):
        with self.lock:
            if self._scan_in_progress:
                return
            self._scan_in_progress = True

        def _worker():
            try:
                self.refresh_now(store, t3_dir=t3, usage_home=home, opencode_db=oc)
            except Exception:
                pass
            finally:
                with self.lock:
                    self._scan_in_progress = False

        threading.Thread(target=_worker, daemon=True).start()

    def _refresh_opencode(self, opencode_db, now):
        db_path = Path(opencode_db)
        if not db_path.is_file():
            self.opencode_records = []
            self.opencode_sig = None
            return False
        wal = db_path.with_name(db_path.name + "-wal")
        try:
            st = db_path.stat()
            wst = wal.stat() if wal.is_file() else None
            sig = (st.st_mtime_ns, st.st_size, wst.st_mtime_ns if wst else 0, wst.st_size if wst else 0)
        except OSError:
            return False
        if sig == self.opencode_sig and now - self.opencode_at < 300:
            return bool(self.opencode_records)
        self.opencode_records = read_opencode_usage(db_path, now - RETENTION_SECONDS)
        self.opencode_sig = sig
        self.opencode_at = now
        return True

    def breakdown(self, store, hours=24, provider="all", now=None, t3_dir=None, usage_home=None, opencode_db=None, sync=False):
        """Return project and thread usage breakdown for the requested lookback window and provider."""
        now = float(time.time() if now is None else now)
        hours = min(max(int(hours), 1), 336)
        provider = str(provider or "all").strip().lower() or "all"
        if os.environ.get("DASHBOARD_USAGE_BREAKDOWN") == "0":
            return self._empty_response(hours, provider, now, available=False)

        t3, home, oc = self._default_paths(t3_dir, usage_home, opencode_db)
        need_async = False
        with self.lock:
            if self.meta is None or (sync and now - self.meta_at >= self.scan_ttl):
                self.meta = load_t3_metadata(t3)
                self.meta_at = now
            meta = self.meta
            due = now - self.last_scan_at >= self.scan_ttl
            if due:
                if sync or self.last_scan_at == 0.0:
                    has_files = self._scan_files_into_store(store, t3, home, now)
                    self._refresh_opencode(oc, now)
                    self.last_scan_at = now
                    self._has_any_source = bool(meta["has_db"] or has_files or self.opencode_records)
                else:
                    need_async = True
                    has_files = bool(store.usage_file_states())
            else:
                has_files = bool(store.usage_file_states())
            oc_records = list(self.opencode_records)
            agy_parents = dict(self.agy_parents)
        if need_async:
            self._trigger_async_refresh(store, t3, home, oc)

        available = bool(meta["has_db"] or has_files or oc_records)
        if not available:
            return self._empty_response(hours, provider, now, available=False)

        since_ts = int((now - hours * 3600) // BUCKET_SECONDS) * BUCKET_SECONDS
        file_rows = store.usage_file_buckets(since_ts)

        totals = _empty_metrics()
        projects_agg = {}  # proj_id -> {id, title, metrics, threads: {root_tid -> ...}, subagents: set}
        threads_agg = {}  # root_tid -> {id, title, project_id, project_title, metrics, subagents: set}

        def resolve_owner(source, session_id, parent_session_id, cwd, fallback_title=""):
            """Map one raw usage source record to (project_id, project_title, root_thread_id, thread_title, subagent_id)."""
            sid = str(session_id or "").strip()
            psid = str(parent_session_id or "").strip()
            if source == "antigravity" and sid and sid not in meta["native_to_thread"]:
                parent_conv = agy_parents.get(sid.lower())
                if parent_conv:
                    psid = parent_conv

            # 1. Exact match on T3 native thread ref (session or parent session).
            match = meta["native_to_thread"].get(sid) or (meta["native_to_thread"].get(psid) if psid else None)
            if match:
                tid, _ = match
                t_info = meta["threads"].get(tid)
                if t_info:
                    root_tid = t_info["root_thread_id"]
                    root_info = meta["threads"].get(root_tid) or t_info
                    pid = root_info["project_id"] or t_info["project_id"]
                    p_info = meta["projects"].get(pid)
                    ptitle = p_info["title"] if p_info else (_path_tail(cwd) or "No project")
                    pid = pid or f"dir:{_norm_path(cwd) or 'other'}"
                    sub_id = ""
                    if tid != root_tid:
                        sub_id = tid
                    elif psid and sid and sid != psid:
                        sub_id = f"sub:{sid}"
                    return pid, ptitle, root_tid, root_info["title"], sub_id

            # 2. Fallback: attribute by working directory to a known T3 project or folder name.
            pid = _match_project_by_cwd(cwd, meta)
            if pid and pid in meta["projects"]:
                ptitle = meta["projects"][pid]["title"]
            elif cwd:
                norm_cwd = _norm_path(cwd)
                pid = f"dir:{norm_cwd}"
                ptitle = _path_tail(cwd) or "Other"
            else:
                pid = "other"
                ptitle = "Other / CLI"

            base_sid = psid or sid or "unknown"
            root_tid = f"cli:{source}:{base_sid}"
            if fallback_title:
                ttitle = fallback_title
            else:
                short = base_sid[:8]
                ttitle = f"{source.capitalize()} session · {short}" if base_sid != "unknown" else f"{source.capitalize()} session"
            sub_id = f"sub:{sid}" if (psid and sid and sid != psid) else ""
            return pid, ptitle, root_tid, ttitle, sub_id

        def ingest(source, session_id, parent_session_id, cwd, fallback_title, bts, bprov, model, reqs, inp, outp, read, write):
            if bts < since_ts:
                return
            cprov = canonical_provider(bprov, model)
            if provider != "all" and cprov != provider:
                return
            cost = uncached_api_cost(model, inp, outp, read, write)
            pid, ptitle, root_tid, ttitle, sub_id = resolve_owner(source, session_id, parent_session_id, cwd, fallback_title)

            _add_metrics(totals, cprov, model, bts, reqs, inp, outp, read, write, cost)

            p_entry = projects_agg.get(pid)
            if p_entry is None:
                p_entry = projects_agg[pid] = {
                    "id": pid,
                    "title": ptitle,
                    "metrics": _empty_metrics(),
                    "threads": {},
                    "subagents": set(),
                }
            _add_metrics(p_entry["metrics"], cprov, model, bts, reqs, inp, outp, read, write, cost)
            if sub_id:
                p_entry["subagents"].add(sub_id)

            t_entry = threads_agg.get(root_tid)
            if t_entry is None:
                t_entry = threads_agg[root_tid] = {
                    "id": root_tid,
                    "title": ttitle,
                    "project_id": pid,
                    "project_title": ptitle,
                    "metrics": _empty_metrics(),
                    "subagents": set(),
                }
            _add_metrics(t_entry["metrics"], cprov, model, bts, reqs, inp, outp, read, write, cost)
            if sub_id:
                t_entry["subagents"].add(sub_id)
            p_entry["threads"][root_tid] = t_entry

        for (_path, source, sid, cwd, psid, bts, bprov, model, reqs, inp, outp, read, write) in file_rows:
            ingest(source, sid, psid, cwd, "", int(bts), bprov, model, int(reqs), int(inp), int(outp), int(read), int(write))

        for rec in oc_records:
            for (bts, bprov, model, reqs, inp, outp, read, write) in rec["buckets"]:
                ingest(
                    "opencode",
                    rec["session_id"],
                    rec["parent_session_id"],
                    rec["cwd"],
                    rec["title"],
                    int(bts),
                    bprov,
                    model,
                    int(reqs),
                    int(inp),
                    int(outp),
                    int(read),
                    int(write),
                )

        use_cost_share = totals["cost_usd"] > 0
        denom = totals["cost_usd"] if use_cost_share else max(1, totals["tokens"])

        def share_of(m):
            num = m["cost_usd"] if use_cost_share else m["tokens"]
            return round(num / denom, 4) if denom > 0 else 0.0

        def sort_key(item):
            m = item["metrics"]
            return (-m["cost_usd"], -m["tokens"], -m["requests"], item["title"].lower())

        def thread_view(t_entry):
            m = t_entry["metrics"]
            t_meta = meta["threads"].get(t_entry["id"])
            last_ts = max(m["last_active_at"], int(t_meta["updated_at"]) if (t_meta and t_meta.get("updated_at") and t_meta["updated_at"] <= now) else 0)
            return {
                "id": t_entry["id"],
                "title": t_entry["title"],
                "project_id": t_entry["project_id"],
                "project_title": t_entry["project_title"],
                "cost_usd": round(m["cost_usd"], 4),
                "priced": m["priced_tokens"] > 0,
                "share": share_of(m),
                "tokens": int(m["tokens"]),
                "io_tokens": int(m["io_tokens"]),
                "input_tokens": int(m["input_tokens"]),
                "output_tokens": int(m["output_tokens"]),
                "cache_read_tokens": int(m["cache_read_tokens"]),
                "cache_write_tokens": int(m["cache_write_tokens"]),
                "requests": int(m["requests"]),
                "subagent_count": len(t_entry["subagents"]),
                "last_active_at": last_ts or None,
                "providers": _finalize_providers(m["providers"]),
                "models": _top_models(m["models"]),
            }

        projects_out = []
        for p_entry in sorted(projects_agg.values(), key=sort_key)[:MAX_PROJECTS]:
            m = p_entry["metrics"]
            p_threads = [thread_view(t) for t in sorted(p_entry["threads"].values(), key=sort_key)[:MAX_PROJECT_THREADS]]
            projects_out.append({
                "id": p_entry["id"],
                "title": p_entry["title"],
                "cost_usd": round(m["cost_usd"], 4),
                "priced": m["priced_tokens"] > 0,
                "share": share_of(m),
                "tokens": int(m["tokens"]),
                "io_tokens": int(m["io_tokens"]),
                "requests": int(m["requests"]),
                "thread_count": len(p_entry["threads"]),
                "subagent_count": len(p_entry["subagents"]),
                "last_active_at": m["last_active_at"] or None,
                "providers": _finalize_providers(m["providers"]),
                "models": _top_models(m["models"]),
                "threads": p_threads,
            })

        threads_out = [thread_view(t) for t in sorted(threads_agg.values(), key=sort_key)[:MAX_THREADS]]

        return {
            "available": True,
            "hours": hours,
            "provider": provider,
            "now": now,
            "updated_at": self.last_scan_at or now,
            "totals": {
                "cost_usd": round(totals["cost_usd"], 4),
                "priced": totals["priced_tokens"] > 0,
                "tokens": int(totals["tokens"]),
                "io_tokens": int(totals["io_tokens"]),
                "requests": int(totals["requests"]),
                "projects": len(projects_agg),
                "threads": len(threads_agg),
                "providers": _finalize_providers(totals["providers"]),
            },
            "projects": projects_out,
            "threads": threads_out,
        }

    @staticmethod
    def _empty_response(hours, provider, now, available=False):
        return {
            "available": available,
            "hours": hours,
            "provider": provider,
            "now": now,
            "updated_at": now,
            "totals": {
                "cost_usd": 0.0,
                "priced": False,
                "tokens": 0,
                "io_tokens": 0,
                "requests": 0,
                "projects": 0,
                "threads": 0,
                "providers": {},
            },
            "projects": [],
            "threads": [],
        }
