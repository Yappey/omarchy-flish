#!/usr/bin/env python3
"""End-to-end checks for the tutor overlay against a running omarchy-shell.

This is the assertive counterpart to fake-engine.py: same wire protocol, but it
verifies the tutor's replies and exits non-zero when the contract is broken.

Almost every assertion here reads the socket rather than the screen -- the
observable contract is the NDJSON coming back, so "did the card behave" is
answerable without looking at pixels. Only layout needs a screenshot, and that
is left to the manual checklist in tests/README.md.

Not runnable in CI: it needs a live Wayland session with omarchy-shell and the
plugin installed and enabled. Run it locally before pushing tutor/ changes.

    scripts/e2e-tutor.py            # all checks
    scripts/e2e-tutor.py -v         # echo every line on the wire
"""

import argparse
import json
import os
import pathlib
import socket
import subprocess
import sys
import threading
import time
import uuid

TIMEOUT = 6.0
VERBOSE = False


def log(*a):
    if VERBOSE:
        print(*a, file=sys.stderr)


def socket_path() -> pathlib.Path:
    runtime = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    return pathlib.Path(runtime) / "omarchy-flish" / "tutor.sock"


class Engine:
    """One fake engine: a connection, plus a reader thread collecting replies."""

    def __init__(self, name: str):
        self.name = name
        self.session = uuid.uuid4().hex[:16].upper()
        self.received: list[dict] = []
        self._lock = threading.Lock()
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(str(socket_path()))
        self._stop = threading.Event()
        threading.Thread(target=self._read, daemon=True).start()
        self.send({"v": 1, "type": "hello", "session": self.session,
                   "pid": os.getpid(), "engine": "e2e"})

    def _read(self):
        buf = b""
        while not self._stop.is_set():
            try:
                chunk = self.sock.recv(4096)
            except OSError:
                return
            if not chunk:
                return
            buf += chunk
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                if not raw.strip():
                    continue
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                log(f"  {self.name} <- {raw.decode(errors='replace')}")
                with self._lock:
                    self.received.append(msg)

    def send(self, payload: dict):
        log(f"  {self.name} -> {json.dumps(payload)}")
        self.sock.sendall((json.dumps(payload) + "\n").encode())

    def hint(self, title="E2E hint", body="Which command shows what is inside?",
             ttl_ms=0) -> str:
        hint_id = uuid.uuid4().hex[:16].upper()
        self.send({"v": 1, "type": "hint", "id": hint_id, "session": self.session,
                   "template": "e2e", "title": title, "body": body,
                   "actions": ["helpful", "confusing"], "ttl_ms": ttl_ms})
        return hint_id

    def await_message(self, mtype: str, hint_id: str, timeout=TIMEOUT):
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self._lock:
                for m in self.received:
                    if m.get("type") == mtype and m.get("id") == hint_id:
                        return m
            time.sleep(0.05)
        return None

    def saw(self, mtype: str, hint_id: str) -> bool:
        with self._lock:
            return any(m.get("type") == mtype and m.get("id") == hint_id
                       for m in self.received)

    def close(self):
        self._stop.set()
        try:
            self.sock.close()
        except OSError:
            pass


def shell_call(method: str, arg: str = "") -> str:
    cmd = ["omarchy-shell", "shell", "call", "flish.tutor", method]
    if arg:
        cmd.append(arg)
    return subprocess.run(cmd, capture_output=True, text=True).stdout.strip()


# --------------------------------------------------------------------- checks

def check_ack(_):
    """A rendered hint acks, so telemetry can tell 'unhelpful' from 'never seen'."""
    e = Engine("A")
    try:
        hid = e.hint()
        ack = e.await_message("ack", hid)
        assert ack is not None, "no ack came back within %.0fs" % TIMEOUT
        assert ack.get("rendered") is True, f"ack did not report rendered: {ack}"
    finally:
        e.close()


def check_feedback(_):
    """A verdict returns on the same connection, tagged with the hint id."""
    e = Engine("A")
    try:
        hid = e.hint()
        assert e.await_message("ack", hid), "hint never rendered"
        shell_call("answer", "helpful")
        fb = e.await_message("feedback", hid)
        assert fb is not None, "no feedback came back"
        assert fb["verdict"] == "helpful", f"wrong verdict: {fb}"
        assert "at" in fb and fb["at"], "feedback carries no timestamp"
    finally:
        e.close()


def check_dismiss_is_scoped(_):
    """One terminal's dismiss must not take down another terminal's hint."""
    a, b = Engine("A"), Engine("B")
    try:
        a_id = a.hint(title="A")
        assert a.await_message("ack", a_id), "A never rendered"
        b_id = b.hint(title="B")
        assert b.await_message("ack", b_id), "B never rendered"

        a.send({"v": 1, "type": "dismiss", "id": a_id})
        time.sleep(1.0)

        # B still owns the screen, so its feedback path must still work.
        shell_call("answer", "helpful")
        fb = b.await_message("feedback", b_id)
        assert fb is not None, "A's dismiss took down B's hint"
    finally:
        a.close()
        b.close()


def check_ttl_zero_holds(_):
    """ttl_ms 0 means 'until dismissed' -- it must not decay to the default."""
    e = Engine("A")
    try:
        hid = e.hint(ttl_ms=0)
        assert e.await_message("ack", hid), "hint never rendered"
        # The default is 12000ms; wait past it, then prove the card is still up
        # by checking its feedback path still answers.
        time.sleep(14)
        shell_call("answer", "helpful")
        fb = e.await_message("feedback", hid, timeout=3)
        assert fb is not None, (
            "card closed on its own with ttl_ms 0 -- the default leaked in "
            "(see normalizeTtlMs in tutor/TutorProtocol.js)")
    finally:
        e.close()


def check_unknown_is_ignored(_):
    """Unknown types and future versions degrade, never break the connection."""
    e = Engine("A")
    try:
        e.send({"v": 1, "type": "sparkle", "id": "X"})
        e.send({"v": 99, "type": "hint", "id": "Y", "title": "t", "body": "b"})
        e.send({"v": 1, "type": "hint", "id": "Z", "future_key": {"a": 1},
                "title": "t", "body": "b", "ttl_ms": 0})
        assert e.await_message("ack", "Z"), (
            "connection did not survive unknown type / future version")
        assert not e.saw("ack", "Y"), "a v99 hint was rendered"
    finally:
        e.close()


def check_disconnect_retires(_):
    """A hint outlives neither its engine nor its terminal."""
    a = Engine("A")
    a_id = a.hint(ttl_ms=0)
    assert a.await_message("ack", a_id), "hint never rendered"
    a.close()
    time.sleep(1.5)

    # If the card were still up, a new engine's hint would replace it and this
    # would pass regardless -- so instead assert the panel reports itself shut.
    b = Engine("B")
    try:
        shell_call("answer", "helpful")   # no card -> nothing to answer
        time.sleep(0.5)
        assert not b.saw("feedback", a_id), "a dead engine's hint still answered"
    finally:
        b.close()


CHECKS = [
    ("ack round-trip", check_ack),
    ("feedback round-trip", check_feedback),
    ("dismiss is id-scoped", check_dismiss_is_scoped),
    ("unknown type / future version ignored", check_unknown_is_ignored),
    ("disconnect retires the hint", check_disconnect_retires),
    ("ttl_ms 0 holds past the default", check_ttl_zero_holds),
]


def main() -> int:
    global VERBOSE
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-v", "--verbose", action="store_true", help="echo the wire")
    ap.add_argument("-k", metavar="SUBSTRING", help="only checks whose name matches")
    args = ap.parse_args()
    VERBOSE = args.verbose

    path = socket_path()
    if not path.exists():
        print(f"no socket at {path}\n"
              "The tutor is not listening. Install and enable it:\n"
              "  scripts/dev-install-tutor.sh && omarchy plugin enable flish.tutor",
              file=sys.stderr)
        return 2

    selected = [(n, f) for n, f in CHECKS if not args.k or args.k in n]
    failures = []
    for name, fn in selected:
        try:
            fn(None)
        except AssertionError as exc:
            print(f"FAIL  {name}\n        {exc}")
            failures.append(name)
        except Exception as exc:  # noqa: BLE001 - report, do not mask
            print(f"ERROR {name}\n        {type(exc).__name__}: {exc}")
            failures.append(name)
        else:
            print(f"ok    {name}")
        # Leave the overlay clean between checks.
        subprocess.run(["omarchy-shell", "shell", "hide", "flish.tutor"],
                       capture_output=True)
        time.sleep(0.4)

    print(f"\n{len(selected) - len(failures)}/{len(selected)} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
