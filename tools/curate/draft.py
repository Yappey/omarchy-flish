#!/usr/bin/env python3
"""Draft candidate hints for uncovered slots using a local LM Studio model.

This is the bootstrap half of the curation lifecycle. curate-template.md
generalises real beta telemetry; this works from the engine's own enumerated
failure surface, so the dictionary can be populated before any child has used
the product and before any telemetry exists.

Nothing here ships. Nothing here is read by the engine. Candidates land in
tools/curate/candidates/ (gitignored) and reach templates/hints/ only when a
person moves them there -- see docs/decisions.md, D9.

    tools/curate/draft.py --list                    # uncovered slots
    tools/curate/draft.py --slot cat/Is_A_Directory
    tools/curate/draft.py --slot cat/Not_Found -n 5 # 5 candidates, keep the ones that pass
    tools/curate/draft.py --all -n 3                # every uncovered slot
    tools/curate/draft.py --models                  # what LM Studio has loaded

By default this refuses to draft with a model LM Studio has not already loaded.
Asking for an unloaded model can trigger a just-in-time load, and this tool
loops -- over candidates, and with --all over every uncovered slot -- so an
unattended run can pull several multi-gigabyte models into memory on a machine
that cannot spare it. Load the model you want first, or pass --allow-jit if you
know the box can take it.

Candidate filenames carry the model, so drafting the same slot with two models
leaves both sets side by side. Which model to author with is a real choice --
a bigger one that passes the gate more often is worth slower generation -- and
this is how you measure it rather than guess.

Every candidate is put through tests/validate-candidate.js before it is
written. Rejects are kept alongside, with the reason, because a model that
keeps failing the same rule is telling you the prompt needs work.
"""

import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
import urllib.error
import urllib.request

REPO = pathlib.Path(__file__).resolve().parent.parent.parent
SLOTS = REPO / "templates" / "schema" / "slots.json"
HINTS = REPO / "templates" / "hints"
SCENARIOS = REPO / "templates" / "scenarios"
PROMPT = REPO / "tools" / "curate" / "prompts" / "author-slot.md"
VALIDATOR = REPO / "tests" / "validate-candidate.js"
OUT = REPO / "tools" / "curate" / "candidates"

DEFAULT_HOST = os.environ.get("FLISH_LMSTUDIO", "http://127.0.0.1:1234")


def load(path):
    return json.loads(path.read_text())


def list_models(host, timeout=15):
    """Every LLM LM Studio knows about, and whether an instance is loaded."""
    with urllib.request.urlopen(f"{host}/api/v1/models", timeout=timeout) as resp:
        payload = json.loads(resp.read())
    return [(m["key"], bool(m.get("loaded_instances")))
            for m in payload.get("models", []) if m.get("type") == "llm"]


def uncovered_slots():
    """Slots the engine can produce that no template covers yet."""
    slots = load(SLOTS)["slots"]
    covered = set()
    for f in HINTS.glob("*.json"):
        t = load(f)
        covered.add((t.get("match", {}).get("command", ""),
                     t.get("match", {}).get("status", "")))
    return [s for s in slots if (s["command"], s["status"]) not in covered]


def slot_key(slot):
    return f"{slot['command'] or '*'}/{slot['status']}"


def model_tag(model):
    """A filename-safe short name: 'google/gemma-4-26b-a4b-qat' -> 'gemma-4-26b-a4b-qat'."""
    return re.sub(r"[^A-Za-z0-9._-]", "-", model.split("/")[-1]) or "model"


def walk(entries, prefix=""):
    for e in entries:
        path = f"{prefix}/{e['name']}"
        yield path, e
        if e["kind"] == "dir":
            yield from walk(e.get("entries", []), path)


def scenario_context(slot):
    """A concrete world for the model to write against.

    Hints are matched against VFS state, so a candidate written with no world in
    mind tends to describe the error rather than the situation. Pick a directory
    with children so `siblings` is meaningful, and a target of the kind this
    slot implies.
    """
    files = list(SCENARIOS.glob("*.json"))
    if not files:
        return {"cwd": "/", "siblings": [], "target": "the_name_you_typed"}

    scenario = load(files[0])
    dirs = [(p, e) for p, e in walk(scenario["entries"]) if e["kind"] == "dir"]
    best = max(dirs, key=lambda pe: len(pe[1].get("entries", [])), default=None)
    if best is None:
        return {"cwd": "/", "siblings": [], "target": "the_name_you_typed"}

    cwd, node = best
    children = node.get("entries", [])
    siblings = [c["name"] for c in children]

    want_dir = slot["status"] == "Is_A_Directory"
    want_file = slot["status"] == "Not_A_Directory"
    target = None
    for c in children:
        if want_dir and c["kind"] == "dir":
            target = c["name"]
        elif want_file and c["kind"] == "file":
            target = c["name"]
    if target is None:
        target = siblings[0] if siblings and slot["has_target"] else "the_name_you_typed"
    if slot["status"] == "Not_Found":
        target = "tresure_map.txt"   # a near-miss, which is the interesting case

    return {"cwd": cwd, "siblings": siblings, "target": target}


def build_input(slot):
    ctx = scenario_context(slot)
    stderr = slot["stderr"].replace("{target}", ctx["target"])
    payload = {
        "command": slot["command"],
        "status": slot["status"],
        "stderr": stderr,
        "concept": slot["concept"],
        "has_target": slot["has_target"],
        "cwd": ctx["cwd"],
        "siblings": ctx["siblings"],
        "applicable_decorators": slot["applicable_decorators"],
        "strike_count": 3,
    }
    if slot["has_target"]:
        payload["target"] = ctx["target"]
    return payload


def chat(host, model, system_prompt, user_input, reasoning="off", timeout=300):
    # Reasoning defaults off, but it is not free either way -- measure it per
    # model rather than assuming. On the same two slots, seven candidates each:
    #
    #   gemma-4-31b           reasoning off   7/7 passed, slowest
    #   gemma-4-26b-a4b-qat   reasoning off   7/7 passed, ~6s each
    #   nemotron-3-nano-4b    reasoning on    2/7 passed, minutes each
    #   nemotron-3-nano-4b    reasoning off   0/7 passed
    #
    # So deliberation is what gets the small model to ask a question instead of
    # stating a fact, and it is pure latency on the capable ones. Off is the
    # right default only because a model like gemma is available; on a 4B model,
    # off produces nothing usable at all.
    #
    # Above 4B the gate stops discriminating -- both gemmas pass everything --
    # and the models fail in ways only a reader catches. See tests/README.md.
    body = json.dumps({
        "model": model,
        "system_prompt": system_prompt,
        "input": user_input,
        "reasoning": reasoning,
    }).encode()
    req = urllib.request.Request(f"{host}/api/v1/chat", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def message_text(response):
    """Pull the assistant message out of LM Studio's typed output array.

    A reasoning model emits a "reasoning" entry before its "message", so
    output[0] is not reliably the answer.
    """
    parts = [o.get("content", "") for o in response.get("output", [])
             if o.get("type") == "message"]
    return "\n".join(parts).strip()


def extract_json(text):
    """Small models like to wrap JSON in prose or a fence. Take the outermost object."""
    text = text.strip()
    if text.startswith("```"):
        text = text.split("```")[1] if "```" in text[3:] else text
        text = text.removeprefix("json").strip()
    start, depth = text.find("{"), 0
    if start < 0:
        return None
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start:i + 1])
                except json.JSONDecodeError:
                    return None
    return None


def gate(candidate_path):
    proc = subprocess.run(["node", str(VALIDATOR), str(candidate_path)],
                          capture_output=True, text=True)
    return proc.returncode == 0, proc.stdout.strip()


def draft_slot(slot, args):
    key = slot_key(slot)
    print(f"\n=== {key} ===")
    payload = build_input(slot)
    system = PROMPT.read_text()
    OUT.mkdir(parents=True, exist_ok=True)

    kept = 0
    for i in range(1, args.n + 1):
        try:
            response = chat(args.host, args.model, system, json.dumps(payload),
                            reasoning=args.reasoning)
        except (urllib.error.URLError, TimeoutError) as exc:
            print(f"  [{i}] model unreachable at {args.host}: {exc}")
            return kept

        text = message_text(response)
        candidate = extract_json(text)
        stem = f'{key.replace("/", "-").replace("*", "any")}.{model_tag(args.model)}' 

        if candidate is None:
            print(f"  [{i}] no JSON in the reply")
            (OUT / f"{stem}.{i}.reject.txt").write_text(text or "(empty)")
            continue
        if candidate == {}:
            print(f"  [{i}] model declined (empty object) -- an acceptable answer")
            continue

        candidate.setdefault("schema_version", 1)
        candidate.setdefault("id", f"{stem.lower()}-{i}")
        path = OUT / f"{stem}.{i}.json"
        path.write_text(json.dumps(candidate, indent=2) + "\n")

        ok, report = gate(path)
        if ok:
            kept += 1
            print(f"  [{i}] PASS  -> {path.relative_to(REPO)}")
        else:
            path.rename(OUT / f"{stem}.{i}.reject.json")
            (OUT / f"{stem}.{i}.reject.txt").write_text(report + "\n")
            print(f"  [{i}] reject: {report.splitlines()[0] if report else '?'}")
    return kept


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default=DEFAULT_HOST)
    ap.add_argument("--model", default=os.environ.get("FLISH_MODEL", ""))
    ap.add_argument("--slot", help="slot key, e.g. cat/Is_A_Directory")
    ap.add_argument("--all", action="store_true", help="every uncovered slot")
    ap.add_argument("--list", action="store_true", help="show uncovered slots and exit")
    ap.add_argument("-n", type=int, default=3, help="candidates per slot (default 3)")
    ap.add_argument("--reasoning", choices=["off", "on"], default="off",
                    help="model deliberation before answering (default off; see chat())")
    ap.add_argument("--models", action="store_true", help="list LM Studio models and exit")
    ap.add_argument("--allow-jit", action="store_true",
                    help="draft with a model that is not loaded, letting LM Studio "
                         "load it on demand. Off by default: this tool loops, so an "
                         "unattended run could pull several large models into memory.")
    ap.add_argument("--show-input", action="store_true", help="print the model input and exit")
    args = ap.parse_args()

    if args.models:
        try:
            for key, loaded in list_models(args.host):
                print(f"{'LOADED  ' if loaded else '        '}{key}")
        except (urllib.error.URLError, TimeoutError) as exc:
            sys.exit(f"LM Studio unreachable at {args.host}: {exc}")
        return 0

    todo = uncovered_slots()

    if args.list:
        print(f"{len(todo)} uncovered slot(s):")
        for s in todo:
            print(f"  {slot_key(s):<24} {s['concept']}")
        return 0

    if args.slot:
        todo = [s for s in load(SLOTS)["slots"] if slot_key(s) == args.slot]
        if not todo:
            sys.exit(f"no slot {args.slot!r}; try --list")
    elif not args.all:
        sys.exit("pass --slot KEY, --all, or --list")

    if args.show_input:
        print(json.dumps(build_input(todo[0]), indent=2))
        return 0

    if not args.model:
        sys.exit("pass --model or set FLISH_MODEL (see --models)")

    # Refuse to trigger a just-in-time load unless asked. This loops over
    # candidates and, with --all, over slots; on a machine with JIT enabled an
    # unattended run could quietly load several models at once.
    if not args.allow_jit:
        try:
            models = list_models(args.host)
        except (urllib.error.URLError, TimeoutError) as exc:
            sys.exit(f"LM Studio unreachable at {args.host}: {exc}")

        known = dict(models)
        if args.model not in known:
            sys.exit(f"LM Studio does not have {args.model!r}. See --models.")
        if not known[args.model]:
            loaded = [k for k, is_loaded in models if is_loaded]
            sys.exit(
                f"{args.model} is not loaded, and drafting it would ask LM Studio to "
                f"load it on demand.\n"
                f"Currently loaded: {', '.join(loaded) if loaded else '(nothing)'}\n"
                f"Load it in LM Studio first, or pass --allow-jit if this machine can "
                f"spare the memory.")

    total = sum(draft_slot(s, args) for s in todo)
    attempted = len(todo) * args.n
    rate = f"{total}/{attempted}" if attempted else "0/0"
    print(f"\n{rate} candidate(s) passed the gate "
          f"({model_tag(args.model)}, reasoning {args.reasoning}), "
          f"in {OUT.relative_to(REPO)}")
    print("Nothing ships until a person reviews one and moves it to templates/hints/.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
