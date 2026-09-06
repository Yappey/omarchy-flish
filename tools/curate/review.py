#!/usr/bin/env python3
"""Review drafted candidates and promote the good ones into the dictionary.

The gate decides whether a candidate is well-formed and safe. It cannot decide
whether the copy is *right*, and that is the whole of a reviewer's job:

  1. Is the explanation true of the world the hint will fire in?
  2. Does it point at the command the child actually wants?
  3. Does every declared decorator earn its place -- and is any missing one
     that the copy silently depends on?

Each of those has already produced a wrong hint that passed every rule. This
tool puts the slot, the scenario and those three questions next to the candidate
so the judgement is cheap to make.

    tools/curate/review.py --list                 # what is pending, with gate status
    tools/curate/review.py --show <name>          # one candidate, in full context
    tools/curate/review.py --accept <name>        # promote to templates/hints/
    tools/curate/review.py --reject <name> [--why "..."]
    tools/curate/review.py                        # walk the queue interactively

Accepting re-runs the gate and refuses anything that fails, so a stale pass from
an older rule set cannot slip through.
"""

import argparse
import json
import pathlib
import shutil
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent.parent
CANDIDATES = REPO / "tools" / "curate" / "candidates"
REJECTED = REPO / "tools" / "curate" / "rejected"
HINTS = REPO / "templates" / "hints"
SLOTS = REPO / "templates" / "schema" / "slots.json"
SCENARIOS = REPO / "templates" / "scenarios"
VALIDATOR = REPO / "tests" / "validate-candidate.js"
WHERE = REPO / "tests" / "where-does-it-fire.js"


def load(path):
    return json.loads(path.read_text())


def pending():
    """Candidate files awaiting a decision, newest first."""
    if not CANDIDATES.exists():
        return []
    # .reject.json was already gated and failed at draft time. Re-offering it
    # here would bury the handful worth reading under everything the machine
    # already decided -- the queue is for judgement, not for re-litigating rules.
    out = [f for f in CANDIDATES.glob("*.json")
           if not f.name.endswith("config.json")
           and not f.name.endswith("reject.json")]
    return sorted(out, key=lambda f: f.stat().st_mtime, reverse=True)


def resolve(name):
    """Accept a full filename, or any unambiguous fragment of one."""
    exact = CANDIDATES / name
    if exact.exists():
        return exact
    hits = [f for f in pending() if name in f.name]
    if not hits:
        sys.exit(f"no candidate matching {name!r}; try --list")
    if len(hits) > 1:
        sys.exit(f"{name!r} matches {len(hits)}:\n  " +
                 "\n  ".join(h.name for h in hits))
    return hits[0]


def gate(path):
    r = subprocess.run(["node", str(VALIDATOR), str(path)],
                       capture_output=True, text=True)
    return r.returncode == 0, r.stdout.strip()


def slot_for(candidate):
    key = (candidate.get("match", {}).get("command", ""),
           candidate.get("match", {}).get("status", ""))
    for s in load(SLOTS)["slots"]:
        if (s["command"], s["status"]) == key:
            return s
    return None


def firing_report(path):
    """Where this template actually fires, from the reference matcher.

    This used to print the tree of whichever scenario the glob happened to
    return first, which told a reviewer nothing about whether the decorators
    held there -- and "is the copy true of the world it fires in?" was the
    reason 26 of 26 candidates were rejected in the first pass. Now it is the
    same evaluation the engine will do, with the copy rendered as a child would
    read it.
    """
    r = subprocess.run(["node", str(WHERE), str(path), "--json"],
                       capture_output=True, text=True)
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        return None


def print_firing(path):
    report = firing_report(path)
    if report is None:
        print("  (could not evaluate -- is the candidate valid JSON?)")
        return
    for entry in report:
        if not entry["fires"]:
            why = entry.get("unreachable") or "requires never hold"
            print(f"  {entry['scenario']}: never fires -- {why}")
            continue
        places = entry["places"]
        start = entry["start"]
        # The starting directory first: it is where a child meets this hint
        # soonest, and where wrong copy does the most damage.
        places = sorted(places, key=lambda p: p["cwd"] != start)
        print(f"  {entry['scenario']}: {len(places)} place(s)")
        for place in places[:2]:
            at = f"{place['cwd']} (start)" if place["cwd"] == start else place["cwd"]
            print(f"    standing in {at}, typing {json.dumps(place['argv'])}")
            print(f"      {place['title']}")
            print(f"      {place['body']}")
        if len(places) > 2:
            print(f"    ... and {len(places) - 2} more")


def show(path):
    c = load(path)
    ok, report = gate(path)
    slot = slot_for(c)

    print(f"\n=== {path.name} ===")
    print(f"gate      : {'PASS' if ok else 'FAIL'}")
    if not ok:
        for line in report.splitlines():
            print(f"            {line}")
    print()
    print(f"id        : {c.get('id')}")
    print(f"match     : {json.dumps(c.get('match'))}")
    print(f"requires  : {json.dumps(c.get('requires')) if c.get('requires') else '(none)'}")
    print(f"min_strike: {c.get('min_strike', 3)}    ttl_ms: {c.get('ttl_ms', 12000)}")
    print(f"title     : {c.get('title')}")
    print(f"body      : {c.get('body')}")

    if slot:
        print()
        print(f"slot      : {slot['command'] or '*'}/{slot['status']} -- {slot['concept']}")
        print(f"stderr    : {slot['stderr']}")
        print(f"decorators that discriminate here: {', '.join(slot['applicable_decorators']) or '(none)'}")

    print()
    print("where it fires, and what the child reads there:")
    print_firing(path)

    print()
    print("judgement -- none of this is checked by the gate:")
    print("  1. Is the copy above TRUE at every place it fires?")
    print("  2. Does it point at the command the child actually wants?")
    print("  3. Does every declared decorator earn its place, and is one missing")
    print("     that the copy depends on (e.g. 'compare with nearby names' needs")
    print("     cwd_has_children, or it fires in an empty folder)?")
    return ok


def accept(path, force=False):
    ok, report = gate(path)
    if not ok and not force:
        print(f"refused: {path.name} does not pass the gate")
        for line in report.splitlines():
            print(f"  {line}")
        return False

    c = load(path)
    hint_id = c.get("id", "")
    dest = HINTS / f"{hint_id}.json"
    if dest.exists():
        print(f"refused: {hint_id} already exists in templates/hints/")
        return False

    # Ids are referenced by telemetry, so a collision is not a rename problem.
    for existing in HINTS.glob("*.json"):
        if load(existing).get("id") == hint_id:
            print(f"refused: id {hint_id!r} already used by {existing.name}")
            return False

    c.pop("ok", None)
    dest.write_text(json.dumps(c, indent=2) + "\n")
    path.unlink()
    print(f"accepted -> templates/hints/{dest.name}")
    print("Run `cd tests && npm test` before committing: accepting a second")
    print("template for one slot can create an ambiguous tie that only the")
    print("suite catches.")
    return True


def reject(path, why=""):
    REJECTED.mkdir(parents=True, exist_ok=True)
    dest = REJECTED / path.name
    shutil.move(str(path), str(dest))
    if why:
        dest.with_suffix(".why.txt").write_text(why + "\n")
    print(f"rejected -> {dest.relative_to(REPO)}")


def listing():
    rows = pending()
    if not rows:
        print("nothing pending in tools/curate/candidates/")
        return
    print(f"{len(rows)} candidate(s) pending\n")
    for f in rows:
        ok, report = gate(f)
        mark = "PASS" if ok else "fail"
        first = "" if ok else "  " + report.splitlines()[0][:58]
        print(f"  [{mark}] {f.name}{first}")
    print("\n--show <name> for full context, --accept / --reject to decide.")


def interactive():
    rows = pending()
    if not rows:
        print("nothing pending.")
        return
    for f in rows:
        if not f.exists():
            continue
        ok = show(f)
        prompt = "\n[a]ccept  [r]eject  [s]kip  [q]uit > " if ok else \
                 "\ngate FAILED. [r]eject  [s]kip  [q]uit > "
        try:
            choice = input(prompt).strip().lower()
        except (EOFError, KeyboardInterrupt):
            print("\nstopping.")
            return
        if choice == "q":
            return
        if choice == "a" and ok:
            accept(f)
        elif choice == "r":
            reject(f, input("why (optional) > ").strip())


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--show", metavar="NAME")
    ap.add_argument("--accept", metavar="NAME")
    ap.add_argument("--reject", metavar="NAME")
    ap.add_argument("--why", default="", help="note to store with a rejection")
    ap.add_argument("--force", action="store_true",
                    help="accept despite a gate failure. Records a deliberate "
                         "override; do not use to get past a rule you disagree "
                         "with without changing the rule.")
    args = ap.parse_args()

    if args.list:
        return listing()
    if args.show:
        show(resolve(args.show))
        return 0
    if args.accept:
        return 0 if accept(resolve(args.accept), args.force) else 1
    if args.reject:
        reject(resolve(args.reject), args.why)
        return 0
    interactive()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
