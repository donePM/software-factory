#!/usr/bin/env python3
"""Factory dashboard server.

Serves factory/ and turns dashboard buttons into request files in
factory/inbox/. The orchestrator handles them (/factory:inbox or /factory:loop).
This server never writes board.json, backlog.md, or job files.

Run it from anywhere:
    python3 factory/serve.py [--port 8000] [--open]
    python3 factory/serve.py --run [-- <extra claude args>]
    python3 factory/serve.py --bg [...]   # in the background; opens a running one
    python3 factory/serve.py --stop       # stop the background server
    factory/dashboard [...]          # the same, with --open

With --run, a new request starts `claude -p "/factory:inbox"` in the repo root
when no factory session is running.
"""
import argparse
import json
import os
import re
import secrets
import signal
import subprocess
import sys
import threading
import time
import webbrowser
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
INBOX = HERE / "inbox"
AGENTS = HERE / "agents"  # one file per Claude session, written by the factory mod
LOG = INBOX / "runner.log"
INFO = INBOX / "server.info"  # not *.json: pending() reads those
SERVE_LOG = INBOX / "serve.log"
JOB_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,80}$")
MAX_BODY = 16_000
MAX_NOTE = 4_000
STALE = timedelta(minutes=60)
AGENT_LOST = 120  # s: a running agent whose session file is older is lost
AGENT_KEEP = 6 * 3600  # s: older session files are not shown

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


def agents():
    """Subagents of all sessions, newest first, with their run time in ms."""
    t = time.time()
    out = []
    for p in AGENTS.glob("*.json"):
        try:
            age = t - p.stat().st_mtime
            data = json.loads(p.read_text())
        except (OSError, ValueError):
            continue
        if age > AGENT_KEEP or not isinstance(data, dict):
            continue
        for a in data.get("agents") or []:
            if not isinstance(a, dict):
                continue
            ms = a.get("doneMs") or 0
            status = a.get("status")
            if status == "running" and a.get("runSince"):
                if age > AGENT_LOST:
                    status = "lost"  # its session stopped writing: count up to the last write
                ms += (t - age if status == "lost" else t) * 1000 - a["runSince"]
            out.append({k: a.get(k) for k in ("type", "description", "model", "effort", "startedAt")}
                       | {"status": status, "ms": int(max(0, ms)), "session": data.get("session")})
    out.sort(key=lambda a: (a["status"] != "running", -(a["startedAt"] or 0)))
    return out[:30]


def running_server():
    """The background server's info, or None when none runs."""
    # shortcut: kill(pid, 0) trusts the pid; a reused pid looks alive, delete server.info then
    try:
        info = json.loads(INFO.read_text())
        os.kill(info["pid"], 0)
        return info
    except (OSError, ValueError, KeyError, TypeError):
        return None


def start_bg(args):
    """Start this server detached, or find the one that runs. Return its info."""
    info = running_server()
    if info:
        if args.run and not info.get("run"):
            print("The running server has no --run. Stop it with --stop, then start it again.")
        elif args.run and info.get("args") != args.claude_args:
            print("The running server has other claude args. Stop it with --stop, then start it again.")
        return info
    argv = sys.argv[1:]
    cut = argv.index("--") if "--" in argv else len(argv)
    argv = [a for a in argv[:cut] if a not in ("--bg", "--open")] + argv[cut:]
    with open(SERVE_LOG, "a") as log:
        subprocess.Popen(
            [sys.executable, "-u", str(Path(__file__).resolve()), *argv],
            cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    for _ in range(50):
        time.sleep(0.1)
        info = running_server()
        if info:
            return info
    raise SystemExit(f"The dashboard server did not start. See {SERVE_LOG}.")


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
        reqs = [r for r in pending() if r.get("action") != "stop"]  # stop is for a live runner only
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


def validate(req, run_args):
    """Return (request to store, None) or (None, error text)."""
    action = req.get("action")
    board = read_board()
    if action in ("approve", "rework", "start") and runner_status(run_args) == "off":
        return None, "nothing would handle it: start the dashboard with --run, or run /factory:inbox"
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
    if action == "stop":
        child = state["child"]
        if not session_active(board) and not (child and child.poll() is None):
            return None, "no factory runner is running"
        if any(q.get("action") == "stop" for q in queued):
            return None, "stop is already queued"
        return {"action": action}, None
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
            return self.send_json(200, {"pending": pending(), "runner": runner_status(self.run_args), "agents": agents()})
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
            entry, err = validate(req, self.run_args)
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
    ap.add_argument("--open", action="store_true", help="open the dashboard in the browser")
    ap.add_argument("--bg", action="store_true",
                    help="run in the background; when a server already runs, use that one")
    ap.add_argument("--stop", action="store_true", help="stop the background server")
    ap.add_argument("claude_args", nargs="*", help="extra args for claude, after --")
    args = ap.parse_args()
    INBOX.mkdir(exist_ok=True)
    if args.stop:
        info = running_server()
        if info:
            os.kill(info["pid"], signal.SIGTERM)
        INFO.unlink(missing_ok=True)
        print("Stopped the dashboard server." if info else "No dashboard server runs.")
        return
    if args.bg:
        info = start_bg(args)
        print(f"Factory dashboard: {info['url']} (pid {info['pid']}, "
              f"{'with' if info.get('run') else 'without'} --run, log {SERVE_LOG.relative_to(ROOT)})")
        if args.open:
            webbrowser.open(info["url"])
        return
    Handler.run_args = args.claude_args if args.run else None
    Handler.allowed = {f"localhost:{args.port}", f"127.0.0.1:{args.port}"}
    url = f"http://localhost:{args.port}/dashboard.html"
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as e:
        raise SystemExit(f"Port {args.port} is not free ({e.strerror}). Is the dashboard already running? Try --port.")
    print(f"Factory dashboard: {url}")
    print("Buttons queue requests in factory/inbox/. " + (
        "New requests start claude -p /factory:inbox." if args.run
        else "Run /factory:inbox or /factory:loop in Claude Code to handle them."))
    INFO.write_text(json.dumps({"pid": os.getpid(), "url": url, "run": args.run,
                               "args": args.claude_args if args.run else None}) + "\n")
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    if args.open:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            if json.loads(INFO.read_text()).get("pid") == os.getpid():
                INFO.unlink()
        except (OSError, ValueError):
            pass


if __name__ == "__main__":
    main()
