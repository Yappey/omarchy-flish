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
PROFILES = REPO / "tools" / "curate" / "model-profiles.json"
HINT_SCHEMA = REPO / "templates" / "schema" / "hint.schema.json"
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


def reasoning_options(host, model, timeout=15):
    """What reasoning settings this model actually accepts.

    Models disagree: the gemmas and qwens take off/on, muse-glimmer takes
    low/medium/high/xhigh and 400s on "off". Sending a value blind means
    discovering that one generation at a time, so ask first.
    """
    try:
        with urllib.request.urlopen(f"{host}/api/v1/models", timeout=timeout) as resp:
            payload = json.loads(resp.read())
    except (urllib.error.URLError, TimeoutError):
        return []
    for m in payload.get("models", []):
        if m.get("key") == model:
            return list(((m.get("capabilities") or {}).get("reasoning") or {})
                        .get("allowed_options") or [])
    return []


def resolve_reasoning(host, model, requested):
    """Pick a reasoning setting this model will accept.

    None means send no field at all and let the model use its own default,
    which is the only safe answer when we cannot tell what it supports.
    """
    options = reasoning_options(host, model)
    if requested is not None:
        if options and requested not in options:
            sys.exit(f"{model} does not support reasoning={requested!r}. "
                     f"Supported: {', '.join(options)}")
        return requested
    if not options:
        return None
    # Least deliberation the model offers. "off" where it exists, otherwise the
    # first listed option, which the API orders cheapest-first.
    return "off" if "off" in options else options[0]


def instance_config(host, model, timeout=15):
    """The runtime settings of the loaded instance, or None.

    Pass rates are not comparable across different context lengths, offload
    settings or expert counts, and those are set in the LM Studio UI rather than
    here -- so a run that does not record them cannot be reproduced or fairly
    compared against a later one. Recording it is cheap; re-running a benchmark
    because nobody wrote down the conditions is not.
    """
    try:
        with urllib.request.urlopen(f"{host}/api/v1/models", timeout=timeout) as resp:
            payload = json.loads(resp.read())
    except (urllib.error.URLError, TimeoutError):
        return None
    for m in payload.get("models", []):
        if m.get("key") != model:
            continue
        for inst in m.get("loaded_instances") or []:
            return {"max_context_length": m.get("max_context_length"),
                    **(inst.get("config") or {})}
    return None


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


def profile_for(model):
    """Published-model-card settings for this model, or the fallback.

    Every card recommends different sampling parameters and none of them match
    LM Studio's defaults, which is what the tool used to send. That made the
    defaults part of what the benchmark measured.
    """
    data = load(PROFILES)
    for entry in data["profiles"]:
        if model.startswith(entry["match"]):
            return entry
    return {"name": model, "sampling": data["defaults"]["sampling"],
            "suitability": "unknown",
            "notes": "No profile; using conservative defaults. Read the card and add one.",
            "source": ""}


def hint_response_format():
    """A JSON-schema response_format built from the shipped hint schema.

    Constraining the decoder is strictly better than parsing prose afterwards:
    it removes the entire class of failure where a model answers correctly but
    not in JSON, which cost this benchmark several candidates before the reply
    parser was fixed.
    """
    schema = load(HINT_SCHEMA)
    schema = {k: v for k, v in schema.items() if not k.startswith("$")}
    return {"type": "json_schema",
            "json_schema": {"name": "flish_hint", "strict": True, "schema": schema}}


def run_mode(args):
    """How the run was configured, for filenames. Endpoint and grammar are
    separate axes, so both belong in the name -- collapsing them is what made
    an earlier comparison unreadable."""
    if args.endpoint == "native":
        return f"native-r-{args.reasoning}"
    return "messages-grammar" if args.structured else "messages"


def model_tag(model):
    """A filename-safe short name: 'google/gemma-4-26b-a4b-qat' -> 'gemma-4-26b-a4b-qat'."""
    return re.sub(r"[^A-Za-z0-9._-]", "-", model.split("/")[-1]) or "model"


def walk(entries, prefix=""):
    for e in entries:
        path = f"{prefix}/{e['name']}"
        yield path, e
        if e["kind"] == "dir":
            yield from walk(e.get("entries", []), path)


def all_worlds():
    """Every scenario, as the child actually meets it.

    A template is universally quantified over worlds that satisfy its
    `requires`; it is not a description of one world. Showing the model a single
    arbitrary directory taught it the opposite -- it wrote "which file did you
    mean to read?" against a directory that had files, and that copy is false at
    the root of the Lighthouse, where there are only folders. Every rejection
    citing "false in /" traced back to here.

    Worse, the scenario was picked with list(glob)[0], so which world the model
    saw depended on filesystem order and could change between runs.
    """
    worlds = []
    for f in sorted(SCENARIOS.glob("*.json")):
        s = load(f)
        entries = list(walk(s["entries"]))
        cwd = s["cwd"]
        here = [e for p, e in entries
                if p.rsplit("/", 1)[0] == ("" if cwd == "/" else cwd)]
        worlds.append({
            "scenario": s["id"],
            "cwd": cwd,
            "here": [{"name": e["name"], "kind": e["kind"]} for e in here],
            "has_files": any(e["kind"] == "file" for e in here),
            "has_dirs": any(e["kind"] == "dir" for e in here),
        })
    return worlds


def scenario_context(slot):
    """One concrete example, drawn from the scenario the child starts in.

    Kept because copy written against no world at all describes the error
    instead of the situation -- but labelled as one example among several, not
    as the world.
    """
    worlds = all_worlds()
    if not worlds:
        return {"cwd": "/", "here": [], "target": "the_name_you_typed"}

    world = worlds[0]
    names = [e["name"] for e in world["here"]]
    want_dir = slot["status"] == "Is_A_Directory"
    want_file = slot["status"] == "Not_A_Directory"

    target = None
    for e in world["here"]:
        if want_dir and e["kind"] == "dir":
            target = e["name"]
        elif want_file and e["kind"] == "file":
            target = e["name"]
    if target is None:
        target = names[0] if names and slot["has_target"] else "the_name_you_typed"
    if slot["status"] == "Not_Found":
        target = "lighthosue"   # a near-miss, which is the interesting case

    return {"cwd": world["cwd"], "here": world["here"], "target": target}


def build_input(slot):
    manifest = load(SLOTS)
    decorators = manifest.get("decorators", {})
    forbidden = manifest.get("forbidden_vocabulary", {}).get("words", [])
    ctx = scenario_context(slot)
    stderr = slot["stderr"].replace("{target}", ctx["target"])
    payload = {
        "command": slot["command"],
        "status": slot["status"],
        "stderr": stderr,
        "concept": slot["concept"],
        "has_target": slot["has_target"],
        "example_world": {
            "cwd": ctx["cwd"],
            "here": ctx["here"],
            "note": "ONE example. The copy must hold in every world below, not "
                    "just this one.",
        },
        "all_worlds": all_worlds(),
        # Name and meaning, not just name. Handed a bare list, a model
        # generalises from the majority: every other decorator is a boolean, so
        # argv_count came back as `true` on every Bad_Usage candidate. The
        # descriptions already exist in slots.json and say "an integer, not a
        # boolean" -- they simply were not being passed on.
        # The gate rejects these outright. Telling the model up front turns a
        # whole batch of identical rejections into copy it can actually write --
        # every Bad_Usage candidate came back using the word "arguments", which
        # is precisely the concept that slot teaches.
        "forbidden_words": forbidden,
        "applicable_decorators": {
            name: decorators.get(name, "") for name in slot["applicable_decorators"]
        },
        # Same channel as applicable_decorators, and for the same reason. Said
        # in the system prompt instead, a second placeholder destabilises the
        # output shape outright: gemma-4-26b went from drafting single templates
        # to emitting {"hints": [...]} on 7 of 8 replies. The prose section is
        # full. Structured input is where this model still reads carefully.
        "placeholders": placeholders_for(slot),
        "strike_count": 3,
    }
    if slot["has_target"]:
        payload["target"] = ctx["target"]
    else:
        # The gate's one truth rule, stated as a rule. Without a target the copy
        # can only be pointing at what is lying around, and the decorator is the
        # only thing that says anything is. Descriptions alone did not carry it:
        # every candidate asked "which file did you mean?" on a slot whose
        # requires said nothing about files.
        payload["grounding_rules"] = [
            'Writing "which file" or "what file" requires "cwd_has_files": true'
            ' in your requires.',
            'Writing "which folder" or "what folder" requires "cwd_has_dirs":'
            ' true in your requires.',
        ]
    return payload


def placeholders_for(slot):
    """What the body may interpolate, and what each one costs to use.

    Mirrors placeholderProblems in tests/helpers/dictionary.js. A placeholder is
    legal only where the engine can guarantee a value, so {{near}} carries the
    decorator that guarantees it rather than being offered unconditionally.
    """
    legal = {}
    if slot["has_target"]:
        legal["{{target}}"] = "The name the child typed. Always available here."
    if "target_near_sibling" in slot["applicable_decorators"]:
        legal["{{near}}"] = ("The closest name that really is in the folder. "
                             "Allowed only if your requires contains "
                             "\"target_near_sibling\": true.")
    return legal


def chat(host, model, system_prompt, user_input, reasoning="off", sampling=None, timeout=300):
    """One generation. Raises TimeoutError if the model is just slow, and
    URLError if LM Studio is actually gone -- the caller treats those
    differently, because one candidate being slow is not a reason to abandon
    the batch."""
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
    #
    # Those timings were taken with flash attention off and a physical batch of
    # 8192 against llama.cpp's default of 512, which on a unified-memory APU
    # pins a compute buffer large enough to starve the host into swap. Fixing
    # both made the same model 9x faster. Record the runtime settings and
    # compare timings only within one configuration.
    payload = {
        "model": model,
        "system_prompt": system_prompt,
        "input": user_input,
    }
    if reasoning is not None:
        payload["reasoning"] = reasoning
    if sampling:
        payload.update(sampling)
    body = json.dumps(payload).encode()
    req = urllib.request.Request(f"{host}/api/v1/chat", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def chat_messages(host, model, system_prompt, user_input, sampling=None,
                  constrain=False, timeout=300):
    """The OpenAI-compatible endpoint, optionally with the decoder constrained.

    The two endpoints differ in more than the grammar, and the difference that
    matters is the prompt format. LM Studio's own API takes system_prompt and
    input as separate fields; this one takes a messages array and applies the
    model's chat template. On qwen3.6-35b-a3b that alone decided whether the
    copy asked a question: 1 of 7 through the native fields, 3 of 3 here with no
    grammar at all.

    So `constrain` is a separate axis from the endpoint, and worth leaving off
    unless a model cannot be trusted to emit JSON -- phi-4-mini-reasoning being
    the case where it was the difference between unusable and usable."""
    payload = {
        "model": model,
        "messages": [{"role": "system", "content": system_prompt},
                     {"role": "user", "content": user_input}],
    }
    if constrain:
        payload["response_format"] = hint_response_format()
    if sampling:
        payload.update(sampling)
    req = urllib.request.Request(f"{host}/v1/chat/completions",
                                 data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read())
    content = data["choices"][0]["message"]["content"]
    return {"output": [{"type": "message", "content": content}]}


def message_text(response):
    """Pull the assistant message out of LM Studio's typed output array.

    A reasoning model emits a "reasoning" entry before its "message", so
    output[0] is not reliably the answer.
    """
    parts = [o.get("content", "") for o in response.get("output", [])
             if o.get("type") == "message"]
    return "\n".join(parts).strip()


def extract_json(text):
    """Pull the candidate object out of a reply.

    Models put it in very different places. Some return bare JSON; some fence
    it; some -- phi-4-mini-reasoning especially -- emit their whole reasoning
    chain inline as <think> prose that *discusses* JSON, then give the real
    answer last. Taking the first brace finds a fragment in the reasoning and
    throws the actual answer away, which is a bug in the reader rather than the
    model.

    So: drop think blocks, then work from the end backwards, and prefer an
    object that looks like a hint template over one that merely parses.
    """
    text = str(text or "")

    # <think>...</think>, and an unclosed <think> that runs to the answer.
    text = re.sub(r"<think>.*?</think>", " ", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"^.*<think>", " ", text, flags=re.DOTALL | re.IGNORECASE)

    candidates = []

    # Fenced blocks first: if a model fenced something, that is its answer.
    for block in re.findall(r"```(?:json)?\s*(.*?)```", text, flags=re.DOTALL):
        candidates.append(block)

    # Then every balanced {...} span in the remaining prose.
    depth, start = 0, None
    for i, ch in enumerate(text):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}" and depth:
            depth -= 1
            if depth == 0 and start is not None:
                candidates.append(text[start:i + 1])

    parsed = []
    for raw in candidates:
        try:
            value = json.loads(raw.strip())
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            parsed.append(value)

    if not parsed:
        return None

    # Last-first: the answer follows the reasoning. Prefer something shaped like
    # a template over a fragment the model quoted while thinking out loud.
    for value in reversed(parsed):
        if "match" in value or "body" in value:
            return value
    return parsed[-1]


def looks_degenerate(candidate):
    """True when a reply parsed as JSON but is not an attempt at the task.

    qwen3.8-27b answers the authoring prompt with {"ok": true} through the
    messages endpoint and with real hints through the native one, so an endpoint
    that suits one model can produce nothing usable from another. Without this
    check that shows up as a schema rejection and reads like bad copy, which
    sends you tuning a prompt when the request shape is what is wrong.
    """
    if not isinstance(candidate, dict):
        return True
    return "match" not in candidate and "body" not in candidate


REPAIRABLE = ("schema_version", "id", "match", "requires", "min_strike",
              "title", "body", "ttl_ms")

# Field names that belong to the *input* the model was handed, not to a
# template. Finding one inside `match` means the model copied part of its brief
# into its answer -- an echo with no meaning to strip away, unlike an invented
# decorator, which may be exactly what the copy is leaning on.
INPUT_ECHO = ("concept", "has_target", "example_world", "all_worlds",
              "forbidden_words", "applicable_decorators", "strike_count")


def repair(candidate):
    """Fix what is only formatting, and report what was fixed.

    A generation costs a model call; throwing one away because the id had an
    underscore in it buys nothing. These are faults with exactly one correct
    repair, so applying it here loses no information and the gate still runs
    afterwards on the repaired object.

    What is deliberately NOT repaired is anything semantic. A decorator the
    schema does not know cannot be dropped, because the copy may be leaning on
    it -- silently deleting it turns "this hint depends on a condition that does
    not exist" into a hint that fires everywhere and lies. Same for a narrowed
    `match`. Those stay rejections, which is the whole point of keeping repair
    in the drafting tool and out of the gate: a committed template has to be
    right as written.
    """
    fixed = []

    for key in [k for k in candidate if k not in REPAIRABLE]:
        candidate.pop(key)
        fixed.append(f"dropped unknown field {key!r}")

    match = candidate.get("match")
    if isinstance(match, dict):
        for key in [k for k in match if k in INPUT_ECHO]:
            match.pop(key)
            fixed.append(f"dropped echoed input field match.{key!r}")

    raw_id = str(candidate.get("id", ""))
    kebab = re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", raw_id.lower())).strip("-")
    if kebab and kebab != raw_id:
        candidate["id"] = kebab
        fixed.append(f"id {raw_id!r} -> {kebab!r}")

    for field in ("title", "body"):
        text = candidate.get(field)
        if isinstance(text, str) and "`" in text:
            candidate[field] = text.replace("`", "")
            fixed.append(f"stripped backticks from {field}")

    # A count the model wrote as "0" means the integer, not a different answer.
    count = candidate.get("requires", {}).get("argv_count") if isinstance(
        candidate.get("requires"), dict) else None
    if isinstance(count, str) and count.strip().isdigit():
        candidate["requires"]["argv_count"] = int(count)
        fixed.append(f"argv_count {count!r} -> {int(count)}")

    for field, default in (("min_strike", 3), ("ttl_ms", 14000)):
        if field not in candidate:
            candidate[field] = default
            fixed.append(f"{field} defaulted to {default}")

    return candidate, fixed


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
    degenerate = 0
    for i in range(1, args.n + 1):
        try:
            kwargs = {"sampling": args.sampling, "timeout": args.timeout}
            if args.endpoint == "native":
                call = chat
                kwargs["reasoning"] = args.reasoning
            else:
                call = chat_messages
                kwargs["constrain"] = args.structured
            response = call(args.host, args.model, system, json.dumps(payload), **kwargs)
        except TimeoutError:
            # Slow, not gone. Reasoning on a large dense model can run for many
            # minutes per candidate, and one that overruns must not take the
            # rest of the batch with it -- especially under --all, where the
            # run is long and nobody is watching.
            print(f"  [{i}] timed out after {args.timeout}s "
                  f"(raise --timeout, or try --reasoning off)")
            continue
        except urllib.error.HTTPError as exc:
            # The server answered and said no. It will say no identically to
            # every remaining candidate, so stop -- but surface what it said,
            # which is usually the whole explanation.
            # Fall back to the raw body rather than nothing. A bare status code
            # sends you looking in the wrong place -- this handler once printed
            # "(HTTP 400)" for what turned out to be a model being unloaded
            # mid-request, which the body would have said outright.
            raw = b""
            try:
                raw = exc.read()
                detail = json.loads(raw).get("error", {}).get("message", "")
            except Exception:  # noqa: BLE001 - diagnostics must not mask the error
                detail = ""
            if not detail and raw:
                detail = raw.decode("utf-8", "replace").strip()[:200]
            print(f"  [{i}] rejected by LM Studio (HTTP {exc.code})"
                  + (f": {detail}" if detail else ""))
            return kept
        except urllib.error.URLError as exc:
            print(f"  [{i}] LM Studio unreachable at {args.host}: {exc}")
            return kept

        text = message_text(response)
        candidate = extract_json(text)
        # How the run was configured is part of its identity, not a detail:
        # drafting the same slot two ways is exactly the comparison worth
        # making, and without it in the name the second run silently overwrites
        # the first. --structured sends no reasoning setting at all, so
        # labelling those files r-off would be a lie about what was requested.
        mode = run_mode(args)
        stem = f'{key.replace("/", "-").replace("*", "any")}.{model_tag(args.model)}.{mode}'

        if candidate is None:
            print(f"  [{i}] no JSON in the reply")
            (OUT / f"{stem}.{i}.reject.txt").write_text(text or "(empty)")
            continue
        if candidate == {}:
            print(f"  [{i}] model declined (empty object) -- an acceptable answer")
            continue

        if looks_degenerate(candidate):
            degenerate += 1
            print(f"  [{i}] reply is JSON but not an attempt at the task: "
                  f"{json.dumps(candidate)[:70]}")
            (OUT / f"{stem}.{i}.reject.txt").write_text(text or "(empty)")
            continue

        candidate.setdefault("schema_version", 1)
        candidate.setdefault("id", f"{stem.lower()}-{i}")
        candidate, fixed = repair(candidate)
        if fixed:
            print(f"  [{i}] repaired: {'; '.join(fixed)}")
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

    if degenerate and degenerate >= args.n / 2:
        other = "native" if args.endpoint == "messages" else "messages"
        print(f"  ! {degenerate}/{args.n} replies were JSON but not attempts at the task.")
        print(f"    That usually means the request shape does not suit this model.")
        print(f"    Try --endpoint {other} before changing the prompt.")
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
    ap.add_argument("--reasoning", default=None,
                    help="deliberation setting, validated against what the model "
                         "reports it accepts (off/on for most, low/medium/high/xhigh "
                         "for others). Default: the cheapest option the model offers.")
    ap.add_argument("--timeout", type=int, default=300,
                    help="seconds per generation (default 300). Reasoning on a "
                         "large dense model can exceed this; a candidate that "
                         "overruns is skipped, not fatal.")
    ap.add_argument("--endpoint", choices=["messages", "native"], default="messages",
                    help="messages (default) uses /v1/chat/completions and the "
                         "model's chat template; native uses LM Studio's own API, "
                         "which is the only one exposing the reasoning control. "
                         "The prompt format alone changes instruction-following "
                         "markedly -- see tests/README.md.")
    ap.add_argument("--structured", action="store_true",
                    help="also constrain the decoder to the hint schema. Separate "
                         "from --endpoint: worth it for a model that cannot be "
                         "trusted to emit JSON, unnecessary for most.")
    ap.add_argument("--temperature", type=float, default=None,
                    help="override the model card's temperature. The cards "
                         "recommend settings for open-ended chat -- Gemma 4 "
                         "asks for 1.0 -- and this task is not that: eleven "
                         "hard rules and one JSON shape. Lower is how you find "
                         "out whether a result is the prompt or the sampler.")
    ap.add_argument("--raw-sampling", action="store_true",
                    help="send no sampling parameters and use the server's "
                         "defaults, as this tool did before model profiles existed")
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

    # Record the conditions alongside the candidates, so a comparison run months
    # from now is not guesswork about how LM Studio was configured at the time.
    profile = profile_for(args.model)
    args.sampling = None if args.raw_sampling else dict(profile["sampling"])
    if args.temperature is not None:
        if args.sampling is None:
            args.sampling = {}
        args.sampling["temperature"] = args.temperature
    if profile["suitability"] == "out-of-scope":
        print(f"warning: {profile['name']} is out of scope for this task.")
        print(f"         {profile['notes']}")
    print(f"{profile['name']}  suitability={profile['suitability']}  "
          f"sampling={json.dumps(args.sampling) if args.sampling else 'server defaults'}")

    args.reasoning = resolve_reasoning(args.host, args.model, args.reasoning)
    config = instance_config(args.host, args.model)
    if config:
        interesting = ("context_length", "max_context_length", "flash_attention",
                       "num_experts", "offload_kv_cache_to_gpu")
        summary = "  ".join(f"{k}={config[k]}" for k in interesting if k in config)
        print(f"{model_tag(args.model)}  reasoning={args.reasoning}  {summary}")
        OUT.mkdir(parents=True, exist_ok=True)
        mode = run_mode(args)
        (OUT / f"{model_tag(args.model)}.{mode}.config.json").write_text(
            json.dumps({"model": args.model,
                        "reasoning": None if args.structured else args.reasoning,
                        "structured": args.structured,
                        "sampling": args.sampling,
                        "config": config}, indent=2) + "\n")

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
