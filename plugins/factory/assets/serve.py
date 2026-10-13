#!/usr/bin/env python3
"""Factory dashboard server.

Serves factory/ and turns dashboard buttons into request files in
factory/inbox/. The orchestrator handles them (/factory:inbox or /factory:loop).
This server never writes board.json, backlog.md, or job files.

Run it from anywhere:
    python3 factory/serve.py [--port 8000]
    python3 factory/serve.py --run [-- <extra claude args>]

With --run, a new request starts `claude -p "/factory:inbox"` in the repo root
when no factory session is running.
"""
import argparse
import json
import os
import re
import secrets
import subprocess
import threading
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
INBOX = HERE / "inbox"
LOG = INBOX / "runner.log"
JOB_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,80}$")
MAX_BODY = 16_000
MAX_NOTE = 4_000
STALE = timedelta(minutes=60)

lock = threading.Lock()
state = {"child": None, "spawned_for": None}


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_board():
    try:
        return json.loads((HERE / "board.json").read_text())
    except (OSError, ValueError):
        return {"jobs": []}


def open_items():
    try:
        text = (HERE / "backlog.md").read_text()
    except OSError:
        return []
    return [m.group(1).strip() for m in re.finditer(r"^- \[ \] (.+)$", text, re.M)]


def pending():
    out = []
    for p in sorted(INBOX.glob("*.json")):
        try:
            req = json.loads(p.read_text())
        except (OSError, ValueError):
            continue
        req["file"] = p.name
        out.append(req)
    return out


def session_active(board):
    runner, beat = board.get("runner"), board.get("heartbeat")
    if not runner or not beat:
        return False
    try:
        t = datetime.fromisoformat(beat.replace("Z", "+00:00"))
    except ValueError:
        return False
    return datetime.now(timezone.utc) - t < STALE


def runner_status(run_args):
    board = read_board()
    child = state["child"]
    if child and child.poll() is None:
        return "running"
    if session_active(board):
        return "session"
    if run_args is None:
        return "off"
    if child and child.returncode != 0:
        return "failed"
    return "idle"


def maybe_spawn(run_args):
    """Start one headless inbox runner, never two, never next to a live session."""
    if run_args is None:
        return
    with lock:
        child = state["child"]
        if child and child.poll() is None:
            return
        reqs = pending()
        if not reqs or session_active(read_board()):
            return
        names = tuple(r["file"] for r in reqs)
        if names == state["spawned_for"]:
            return  # the last runner left these untouched: don't loop on a failure
        state["spawned_for"] = names
        log = open(LOG, "a")
        log.write(f"\n=== {now()} claude -p /factory:inbox\n")
        log.flush()
        state["child"] = subprocess.Popen(
            ["claude", "-p", "/factory:inbox", *run_args],
            cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
        )
        log.close()


def validate(req):
    """Return (request to store, None) or (None, error text)."""
    action = req.get("action")
    board = read_board()
    jobs = {j.get("id"): j for j in board.get("jobs", [])}
    queued = pending()
    if action in ("approve", "rework"):
        job = req.get("job")
        if not isinstance(job, str) or not JOB_ID.match(job) or job not in jobs:
            return None, "unknown job"
        stage = jobs[job].get("stage")
        if action == "approve" and stage != "needs-human":
            return None, f"job is in stage {stage}, not needs-human"
        if action == "rework" and stage in ("merged", "reviewed"):
            return None, f"job is {stage}"
        if any(q.get("job") == job for q in queued):
            return None, "this job already has a queued request"
        if action == "approve":
            return {"action": action, "job": job}, None
        note = req.get("note")
        if not isinstance(note, str) or not note.strip():
            return None, "rework needs a note"
        if len(note) > MAX_NOTE:
            return None, f"note is longer than {MAX_NOTE} characters"
        return {"action": action, "job": job, "note": note.strip()}, None
    if action == "start":
        item = req.get("item")
        if not isinstance(item, str) or item.strip() not in open_items():
            return None, "item is not an open backlog line"
        item = item.strip()
        if any(q.get("item") == item for q in queued):
            return None, "item is already queued"
        return {"action": action, "item": item}, None
    return None, "unknown action"


class Handler(SimpleHTTPRequestHandler):
    run_args = None
    allowed = set()

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(HERE), **kw)

    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def local_only(self):
        # Blocks DNS rebinding (Host) and cross-site posts (Origin, JSON content type).
        if self.headers.get("Host") not in self.allowed:
            return False
        origin = self.headers.get("Origin")
        return origin is None or origin in {f"http://{h}" for h in self.allowed}

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self.send_response(302)
            self.send_header("Location", "/dashboard.html")
            self.end_headers()
            return
        if self.path.split("?")[0] == "/api/inbox":
            if not self.local_only():
                return self.send_json(403, {"error": "forbidden"})
            maybe_spawn(self.run_args)
            return self.send_json(200, {"pending": pending(), "runner": runner_status(self.run_args)})
        if self.path.startswith("/inbox/"):
            return self.send_json(404, {"error": "not found"})
        super().do_GET()

    def do_POST(self):
        if self.path != "/api/actions":
            return self.send_json(404, {"error": "not found"})
        if not self.local_only():
            return self.send_json(403, {"error": "forbidden"})
        if not self.headers.get("Content-Type", "").startswith("application/json"):
            return self.send_json(415, {"error": "send application/json"})
        size = int(self.headers.get("Content-Length") or 0)
        if not 0 < size <= MAX_BODY:
            return self.send_json(413, {"error": "body too large or empty"})
        try:
            req = json.loads(self.rfile.read(size))
        except ValueError:
            return self.send_json(400, {"error": "invalid JSON"})
        if not isinstance(req, dict):
            return self.send_json(400, {"error": "invalid request"})
        with lock:
            entry, err = validate(req)
            if err:
                return self.send_json(409, {"error": err})
            entry["at"] = now()
            name = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f") + "-" + secrets.token_hex(3)
            tmp = INBOX / f".{name}.tmp"
            tmp.write_text(json.dumps(entry, indent=2) + "\n")
            os.replace(tmp, INBOX / f"{name}.json")
        maybe_spawn(self.run_args)
        self.send_json(201, {"queued": name, "runner": runner_status(self.run_args)})


def main():
    ap = argparse.ArgumentParser(description="Serve the factory dashboard with action buttons.")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--run", action="store_true",
                    help='start `claude -p "/factory:inbox"` for new requests when no factory session runs')
    ap.add_argument("claude_args", nargs="*", help="extra args for claude, after --")
    args = ap.parse_args()
    INBOX.mkdir(exist_ok=True)
    Handler.run_args = args.claude_args if args.run else None
    Handler.allowed = {f"localhost:{args.port}", f"127.0.0.1:{args.port}"}
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Factory dashboard: http://localhost:{args.port}/dashboard.html")
    print("Buttons queue requests in factory/inbox/. " + (
        "New requests start claude -p /factory:inbox." if args.run
        else "Run /factory:inbox or /factory:loop in Claude Code to handle them."))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
