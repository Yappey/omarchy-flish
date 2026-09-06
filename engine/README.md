# Flish engine

The Odin core. Runs the REPL, owns the VFS sandbox, tracks strikes, matches
hint templates, and speaks the client half of
[`../docs/ipc-protocol.md`](../docs/ipc-protocol.md).

This directory is the future `omarchy-flish` repository. It imports nothing from
`../tutor` and nothing from `../templates` except the JSON shape documented in
`../templates/schema/`.

> **Picking this up?** [`../docs/engine-handoff.md`](../docs/engine-handoff.md)
> is the quick reference: setup, the contracts the engine has to match, the
> calls that have never been compiled, and what is already proven.

## Package graph

Odin has no cyclic imports, so the dependency direction is fixed and worth
keeping in mind before adding a package:

```
vfs        (no internal deps -- the sandbox, and nothing else)
  ^
commands   (imports vfs)          owns Outcome, Status
  ^
session    (imports commands)     owns State, strikes, mash detection
  ^
hints      (imports vfs, commands, session)   owns Hint, the dictionary
  ^
ipc        (imports hints)        NDJSON over a Unix socket, best-effort
telemetry  (imports hints, session)  local NDJSON append
```

`main` wires them together and owns the per-turn arena.

## Memory

One arena, reset at the top of every REPL turn, installed as
`context.temp_allocator`. Command output, path rendering, and hint bodies all
allocate there and are freed by a single pointer reset. Long-lived state
(the VFS tree, session strike history, the loaded dictionary) uses the normal
heap allocator and is explicitly freed.

If a turn ever needs more than `TURN_ARENA_SIZE`, that is a bug in a command,
not a reason to grow the arena.

## Scenarios

The world is content, loaded from `templates/scenarios/starter.json` rather than
built in code. `FLISH_SCENARIOS_DIR` overrides the lookup the same way
`FLISH_TEMPLATES_DIR` does:

```bash
export FLISH_SCENARIOS_DIR="$PWD/templates/scenarios"
```

A missing scenario is fatal, unlike a missing tutor socket: hints are an
enhancement, but there is no product without a world, so the engine exits rather
than substituting an empty island a child would have to puzzle over.

## Status: scaffolding, not yet compiled

Odin is **not installed on this machine**, so none of the `.odin` files here
have been through the compiler. The structure, package boundaries, and control
flow are the deliverable; expect to fix API drift on the first build.

The calls most likely to need adjustment against the installed Odin version:

| Location | Call | Risk |
|---|---|---|
| `src/main.odin` | `os.read` error type | `os.Error` vs older `os.Errno` |
| `src/vfs/vfs.odin` | `strings.split_iterator` | iterator form and pointer argument |
| `src/commands/commands.odin` | `strings.fields` | return arity, allocator parameter |
| `src/hints/hints.odin` | `os.read_dir` | allocator parameter; `File_Info.fullpath` |
| `src/hints/hints.odin` | `json.unmarshal` into `Maybe(bool)` | optional-field decoding may need a custom path |
| `src/hints/hints.odin` | `slice.sort_by` | comparator signature; `[dynamic]T` to slice |
| `src/vfs/vfs.odin` | `json.unmarshal` into a recursive `[]Scenario_Entry` | self-referencing slice decoding |
| `src/main.odin` | `filepath.join`, `os.exit` | slice-literal argument form |
| `src/ipc/ipc.odin` | none — Unix sockets are unimplemented | see below |
| `src/telemetry/telemetry.odin` | `os.get_env`, `os.make_directory` | return arity, mode argument |

## Known gaps

1. **Unix domain sockets.** `core:net` has no AF_UNIX type. `ipc.connect`
   currently always returns disconnected, so the engine runs permanently in
   degraded mode — correct behaviour, but it means no hint has ever been
   delivered end to end. Implement via `core:sys/linux`.
2. **Regex.** `match.stderr` is specified as a regex but compared as a
   substring. Decide between `core:text/regex` and a PCRE2 binding — see
   `../docs/decisions.md`, D2. Named capture groups are what `{{target}}`
   extraction wants; confirm support before committing.
3. **Line editing.** `read_line` is a raw `os.read`. It needs history, arrow
   keys, and the keystroke-level hook that feeds mash detection.
4. **Mash thresholds.** The heuristic in `session.looks_like_mashing` is a
   guess and must be tuned against real telemetry before shipping.
