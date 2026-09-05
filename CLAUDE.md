# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Omarchy Flish is a sandboxed terminal that teaches children shell basics. Input
is evaluated against an in-memory VFS, never a real shell. Errors print
authentically; when a child gets stuck, a hint is dispatched over a Unix socket
to a desktop overlay that runs inside Omarchy 4's `omarchy-shell`.

## Commands

```bash
engine/scripts/build.sh             # debug build -> engine/build/omarchy-flish
engine/scripts/build.sh release     # -o:speed -no-bounds-check
engine/scripts/test.sh              # odin test tests
export FLISH_TEMPLATES_DIR="$PWD/templates/hints"   # else /usr/share/omarchy-flish/...

scripts/dev-install-tutor.sh        # validate + copy tutor/ into ~/.config/omarchy/plugins/
omarchy plugin enable flish.tutor   # writes the shell.json entry for you
omarchy-plugin-validate tutor       # manifest/entrypoint/symlink/reserved-id checks
```

`test.sh` runs the whole `tests` package; it takes no filter argument, so to
run one test either add an `odin test` flag yourself or invoke the compiler
directly. There is no linter, and `templates/` and `tutor/` have no build step.

### Developing the overlay

The engine cannot deliver a hint yet (see Current state), so the overlay is
developed against stand-ins:

```bash
scripts/fake-engine.py                  # hello + hint, prints ack/feedback back
scripts/fake-engine.py --ttl 0          # hold the card open while styling
scripts/fake-engine.py --long           # long body, shakes out layout bugs
scripts/fake-engine.py --dismiss-after 5

# Visuals only, no socket needed -- the shell summons the panel directly:
omarchy-shell shell summon flish.tutor '{"v":1,"type":"hint","id":"t1","title":"T","body":"B","ttl_ms":0}'

# Invoke a panel method without a mouse (routes to loader.item[method]):
omarchy-shell shell call flish.tutor answer helpful
```

Debugging: `qs list --all` to find the shell instance, then
`qs log -i <id> -t 50` for QML warnings — a plugin that fails to load says so
only there. `hyprctl layers | grep -A4 flish` shows the mapped layer surface.

**Hot-reload is unreliable in practice.** Saving under
`~/.config/omarchy/plugins/` is supposed to reload plugin code, but stale QML
has survived both a re-copy and `omarchy-shell shell rescanPlugins`. When a
change does not appear to take, `omarchy restart shell` always settles it —
check that before debugging the code.

## Architecture

Three components, one repo, laid out along the seams they will eventually split
along. They never import each other by path.

| Dir | Language | Meets the others at |
|---|---|---|
| `engine/` | Odin | `docs/ipc-protocol.md`, `templates/schema/` |
| `tutor/` | QML (Quickshell plugin) | `docs/ipc-protocol.md` |
| `templates/` | JSON | `templates/schema/hint.schema.json` |
| `tools/curate/` | prompts, dev-only | never shipped, never read at runtime |

Anything crossing the engine/tutor line updates `docs/ipc-protocol.md` **first**.
`docs/decisions.md` records why each choice was made and what it costs; read the
relevant entry before reversing one.

Engine package graph is acyclic and fixed:
`vfs → commands → session → hints → {ipc, telemetry}`, with `main` wiring them
and owning a per-turn arena reset every REPL turn.

### The IPC seam

NDJSON over `$XDG_RUNTIME_DIR/omarchy-flish/tutor.sock`, falling back to
`/run/user/$UID/...`. **The tutor listens; the engine connects** — the shell is
the long-lived side, so engines multiplex as connections and an early engine
just retries (D6). Messages: `hello`/`hint`/`dismiss` out, `feedback`/`ack`
back. Unknown types and unknown `v` are ignored, never errors.

Degraded mode is mandatory: if the socket is missing or blocks, the engine
continues with zero user-visible change and never prints an IPC error to the
child's terminal.

### The Omarchy shell plugin contract

The host source is readable at `/usr/share/omarchy/shell` — read it rather than
guessing at the API. `shell.qml` is the host, `services/PluginRegistry.qml` the
validator, `Commons/` the design tokens (`Style`, `Color`, `Util`, `Border`),
`Ui/` the component library (`omarchy dev ui preview` renders a live gallery).

What the host does with a plugin, and the traps in it:

- A `panel` plugin must expose `open(payloadJson)` and `close()`. `summon`
  queues the payload and calls `open()`; `hide` calls `close()`.
- On load the host **assigns** `omarchyPath`, `shell`, `manifest`,
  `barWidgetRegistry`, `pluginRegistry`, and `service` onto the instance. Any of
  these declared `readonly` throws a TypeError that aborts the host's `onLoaded`
  *before* it registers the panel — the plugin then silently never receives
  `open()`. Declare them writable.
- The service and panel halves are created by independent code paths, so neither
  is guaranteed first. Resolve cross-references at call time, not at load.
- `keepLoaded: true` keeps the panel mounted between summons.
- Third-party plugins are enabled iff their id appears in
  `~/.config/omarchy/shell.json`; the `omarchy.*` id namespace is reserved and
  symlinks anywhere inside a plugin folder are rejected (hence D8, and why the
  install script copies).
- A fullscreen layer-shell surface swallows every desktop click unless the input
  region is punched back out with `mask: Region { item: theCard }`. There is no
  `pointer-events: none`. Prefer a fixed fullscreen surface over one sized to
  content — resizing renegotiates the Wayland surface and the compositor briefly
  scales a stale buffer.

Closest first-party references: `plugins/osd/` (transient summoned card),
`plugins/notifications/` (per-output `Variants`, masking, action buttons).

## Product constraints that look like bugs if you don't know them

- **Errors are never suppressed or reworded.** Reading them is the lesson; the
  overlay translates, it does not replace (D3).
- **"No-Do": hints ask, never instruct.** A hint body must not contain a
  runnable command line — the child types the answer. The schema caps `body` at
  240 chars partly to make violating this awkward.
- **No model ships.** Hints are a fixed dictionary of human-approved JSON.
  Unmatched failures produce *no hint*, which is the correct failure mode (D1).
  Two failures printing the same error but teaching different lessons are two
  templates separated by `requires` decorators, not one hedged template.
- **"Curation", not "distillation"** — the words are load-bearing and legally
  loaded; see D9 before renaming anything in `tools/curate/`.
- **Telemetry is children's data.** It goes to `$XDG_STATE_HOME/omarchy-flish/`,
  never the working directory; sync is off by default and opt-in. Raw telemetry
  and fixtures are gitignored and require `git add -f` plus reviewed redaction.
  `NOTICE.md` asks that none of it — or the hint copy — become training data, at
  any model size. Code is MIT; the data ask sits alongside it.

## Current state

- **Engine: scaffolding, never compiled.** Odin is not installed here. Expect
  API drift on first build; `engine/README.md` lists the likely breakages.
- **Engine IPC is a stub.** `core:net` has no AF_UNIX type, so `ipc.connect`
  always returns disconnected and the engine runs permanently degraded. Needs
  `core:sys/linux`. This is why `scripts/fake-engine.py` exists.
- **Regex is unimplemented.** `match.stderr` is specified as a regex but
  compared as a substring; the `{{target}}` extraction wants named captures.
  Decide `core:text/regex` vs a PCRE2 binding (D2).
- **Tutor overlay works end to end** against the fake engine: hint renders,
  `ack` and `feedback` round-trip, dismiss is id-scoped, TTL and disconnect both
  retire the card.
