#!/usr/bin/env python3
"""Deploy only the dashboard, preserving the proxy binary, config, and stock panel."""
import argparse
import hashlib
from pathlib import Path
import re
import shutil
import subprocess
import time

ROOT = Path(__file__).resolve().parent
HUB = Path.home() / "cliproxyapi"
TARGET = HUB / "dashboard"
CORE = [HUB / "cli-proxy-api", HUB / "config.yaml", HUB / "static/management.html"]
# The service runs server.py, which imports these sibling modules.
BACKEND = ["server.py", "claude_routing.py", "quota_readers.py", "request_inputs.py",
           "api_pricing.py", "history_store.py", "silo_accounts.py", "usage_breakdown.py"]
SCRIPT_TAG = re.compile(r'<script src="/dashboard/assets/([a-z-]+)\.js"></script>')
PINNED = re.compile(r"[a-z-]+\.[0-9a-f]{20}\.js")


def fingerprints():
    return {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in CORE}


def place(data, target):
    """Write beside the target and rename over it, so the running server never reads a half-copied file."""
    target.parent.mkdir(parents=True, exist_ok=True)
    staged = target.with_name(target.name + ".next")
    staged.write_bytes(data)
    staged.replace(target)


def install(name, backup):
    current = TARGET / name
    source = ROOT / name
    if current.exists():
        if current.is_dir():
            shutil.copytree(current, backup / name)
        else:
            shutil.copy2(current, backup / name)
    for file in sorted(source.rglob("*")) if source.is_dir() else [source]:
        if file.is_file():
            place(file.read_bytes(), current / file.relative_to(source) if source.is_dir() else current)


def pin_scripts():
    """Install each page script's release copy, assets/<name>.<hash>.js, and return index.html naming
    them. A page then loads one release's scripts even while a deploy or restart is under way, since
    the copies are on disk before any page names them. Copies from releases before the one being
    replaced are removed (the replaced page may still be fetching its own)."""
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    live = (TARGET / "index.html").read_text(encoding="utf-8") if (TARGET / "index.html").exists() else ""
    keep = set(PINNED.findall(live))
    for name in SCRIPT_TAG.findall(html):
        data = (ROOT / "assets" / (name + ".js")).read_bytes()
        pinned = "%s.%s.js" % (name, hashlib.sha256(data).hexdigest()[:20])
        keep.add(pinned)
        if not (TARGET / "assets" / pinned).exists():
            place(data, TARGET / "assets" / pinned)
        html = html.replace('<script src="/dashboard/assets/%s.js">' % name, '<script src="/dashboard/assets/%s">' % pinned)
    for old in (TARGET / "assets").glob("*.js"):
        if PINNED.fullmatch(old.name) and old.name not in keep:
            old.unlink()
    return html.encode("utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frontend-only", action="store_true",
                        help="Publish UI and assets without restarting the dashboard or ending sessions")
    args = parser.parse_args()
    if args.frontend_only:
        # A running backend only routes the asset files it knows, so the page must not get ahead of it.
        stale = [n for n in BACKEND if not (TARGET / n).exists() or (TARGET / n).read_bytes() != (ROOT / n).read_bytes()]
        if stale:
            raise SystemExit("The deployed backend differs (%s); run a full deploy instead." % ", ".join(stale))
    before = fingerprints()
    backup = TARGET / "data" / "releases" / str(int(time.time()))
    backup.mkdir(parents=True, mode=0o700)
    # index.html goes last: it names the asset files, which must already be installed and served by
    # the running backend. The previous page keeps working on the new backend until then.
    names = ["README.md", "DESIGN.md", "assets"]
    if not args.frontend_only:
        names[:0] = BACKEND
    for name in names:
        install(name, backup)
    if fingerprints() != before:
        raise RuntimeError("The proxy's protected files changed during deployment.")
    if not args.frontend_only:
        subprocess.run(["systemctl", "--user", "restart", "cliproxy-dashboard.service"], check=True)
    if (TARGET / "index.html").exists():
        shutil.copy2(TARGET / "index.html", backup / "index.html")
    place(pin_scripts(), TARGET / "index.html")
    if fingerprints() != before:
        raise RuntimeError("The proxy's protected files changed during deployment.")
    print("Dashboard deployed; proxy binary, config, and original panel unchanged.")
    if args.frontend_only:
        print("Refresh the browser to see the UI. Existing sessions remain active.")
    print("Dashboard backup:", backup)


if __name__ == "__main__":
    main()
