#!/usr/bin/env python3
"""Stand in for the Odin engine so the tutor overlay can be developed alone.

The real engine cannot deliver a hint yet -- core:net has no AF_UNIX type, so
engine/src/ipc/ipc.odin always reports disconnected. This speaks the client half
of docs/ipc-protocol.md well enough to exercise the whole duplex contract:
hello, hint, dismiss out; ack and feedback back.

It is also a protocol conformance check. When the engine's socket client lands,
this stays useful as the thing that says whether a tutor change broke the wire
format.

    scripts/fake-engine.py                          # a hint, then wait for feedback
    scripts/fake-engine.py --template cd-missing-target
    scripts/fake-engine.py --ttl 0                  # stay until dismissed
    scripts/fake-engine.py --dismiss-after 3        # exercise the dismiss path
    scripts/fake-engine.py --long                   # a deliberately long body

Two at once, in separate terminals, is how you check that one engine's dismiss
cannot close the other engine's hint.
"""

import argparse
import json
import os
import pathlib
import socket
import sys
import threading
import time
import uuid

REPO = pathlib.Path(__file__).resolve().parent.parent
TEMPLATES = REPO / "templates" / "hints"

LONG_BODY = (
    "The terminal said Not a directory. That means the name you typed is a file, "
    "not a folder, and cd is the command for walking into folders. Files hold "
    "words and pictures inside them instead of holding other things. Which "
    "command do you know that shows you what is written inside a file?"
)


def socket_path() -> pathlib.Path:
    # Matches engine/src/ipc/ipc.odin socket_path() and the tutor's prepareSocket.
    runtime = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    return pathlib.Path(runtime) / "omarchy-flish" / "tutor.sock"


def load_template(name: str) -> dict:
    path = TEMPLATES / f"{name}.json"
    if not path.exists():
        available = sorted(p.stem for p in TEMPLATES.glob("*.json"))
        sys.exit(f"no template {name!r}; have: {', '.join(available) or '(none)'}")
    return json.loads(path.read_text())


def reader(sock: socket.socket, stop: threading.Event) -> None:
    """Print every line the tutor sends back, as it arrives."""
    buf = b""
    while not stop.is_set():
        try:
            chunk = sock.recv(4096)
        except OSError:
            return
        if not chunk:
            print("<- tutor closed the connection")
            return
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            if not line.strip():
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                print(f"<- unparseable: {line!r}")
                continue
            print(f"<- {json.dumps(message)}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--template", default="cd-into-file", help="template id in templates/hints")
    ap.add_argument("--target", default="secret_map.txt", help="value for the {{target}} placeholder")
    ap.add_argument("--ttl", type=int, help="override ttl_ms (0 = stay until dismissed)")
    ap.add_argument("--title", help="override the template title")
    ap.add_argument("--body", help="override the template body")
    ap.add_argument("--long", action="store_true", help="use a deliberately long body")
    ap.add_argument("--dismiss-after", type=float, metavar="SECONDS",
                    help="send a dismiss for this hint after N seconds")
    ap.add_argument("--wait", type=float, default=60.0,
                    help="seconds to stay connected waiting for ack/feedback (default 60)")
    args = ap.parse_args()

    path = socket_path()
    if not path.exists():
        sys.exit(
            f"no socket at {path}\n"
            "The tutor plugin is not listening. Check that it is installed and enabled:\n"
            "  scripts/dev-install-tutor.sh && omarchy plugin enable flish.tutor"
        )

    template = load_template(args.template)
    body = LONG_BODY if args.long else (args.body or template["body"])
    body = body.replace("{{target}}", args.target)
    title = args.title or template["title"]
    ttl = args.ttl if args.ttl is not None else template.get("ttl_ms", 12000)

    session = uuid.uuid4().hex[:16].upper()
    hint_id = uuid.uuid4().hex[:16].upper()

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.connect(str(path))
    except OSError as exc:
        sys.exit(f"could not connect to {path}: {exc}")

    stop = threading.Event()
    threading.Thread(target=reader, args=(sock, stop), daemon=True).start()

    def send(payload: dict) -> None:
        print(f"-> {json.dumps(payload)}")
        sock.sendall((json.dumps(payload) + "\n").encode())

    send({"v": 1, "type": "hello", "session": session,
          "pid": os.getpid(), "engine": "fake-engine"})

    send({"v": 1, "type": "hint", "id": hint_id, "session": session,
          "template": template["id"], "title": title, "body": body,
          "actions": ["helpful", "confusing"], "ttl_ms": ttl})

    print(f"\nhint {hint_id} sent (ttl_ms={ttl}). "
          f"Waiting {args.wait:g}s for ack/feedback -- Ctrl-C to stop.\n")

    try:
        if args.dismiss_after is not None:
            time.sleep(args.dismiss_after)
            send({"v": 1, "type": "dismiss", "id": hint_id})
            time.sleep(max(0.0, args.wait - args.dismiss_after))
        else:
            time.sleep(args.wait)
    except KeyboardInterrupt:
        print("\ninterrupted")
    finally:
        stop.set()
        sock.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
