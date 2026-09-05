# Omarchy Flish IPC Protocol v1

This is the **only** contract between the engine (`engine/`) and the tutor UI
(`tutor/`). Everything else on either side is private. Keeping this file
authoritative is what makes the eventual split into separate repositories a
`git subtree split` rather than a rewrite.

## Transport

A Unix domain stream socket at:

```
$XDG_RUNTIME_DIR/omarchy-flish/tutor.sock
```

Falling back to `/run/user/$UID/omarchy-flish/tutor.sock` when `XDG_RUNTIME_DIR`
is unset.

### Who listens

**The tutor listens; the engine connects.**

The tutor is a plugin inside the long-running `omarchy-shell` Quickshell
process, so it is the stable party. Engine processes are short-lived — one per
terminal session, several at once when a child opens two windows. Making the
long-lived side the server means:

- the engine never has to publish a discoverable socket path per PID;
- several concurrent engines multiplex naturally as several connections;
- an engine that starts before the shell just retries, instead of the shell
  having to hunt for sockets.

> **Deviation from the original architecture doc**, which reads as though the
> Odin engine owns the socket ("Odin handles this statefully using Unix Domain
> Sockets"). The state ownership is unchanged — the engine still owns session,
> strikes, and telemetry — only the listen/connect direction is flipped.

### Degraded mode is mandatory

If the socket is missing, refuses the connection, or blocks, the engine
**must** continue with zero user-visible change. The terminal is the product;
hints are an enhancement. The engine never blocks the REPL on IPC and never
prints an IPC error to the child's terminal.

## Framing

Newline-delimited JSON (NDJSON). One JSON object per line, UTF-8, `\n`
terminated, no embedded raw newlines. Both directions use the same framing on
the same connection.

Unknown `type` values and unknown object keys **must be ignored**, not treated
as errors — that is the forward-compatibility hinge for v1.x.

## Messages

### `hello` — engine → tutor

Sent once immediately after connecting.

```json
{"v":1,"type":"hello","session":"01JB2Z...","pid":48211,"engine":"0.1.0"}
```

### `hint` — engine → tutor

```json
{
  "v": 1,
  "type": "hint",
  "id": "01JB2Z...",
  "session": "01JB2Z...",
  "template": "cd-into-file",
  "title": "That is a file, not a folder",
  "body": "secret_map.txt is a file. Which command shows what is inside a file?",
  "actions": ["helpful", "confusing"],
  "ttl_ms": 12000
}
```

- `id` — unique per hint. Feedback references it. Never reused.
- `template` — the template id that matched, so telemetry can be curated back
  into `templates/`.
- `body` — already rendered; the tutor performs **no** substitution.
- `ttl_ms` — auto-dismiss after this long. `0` means "until dismissed".

The hint body is Socratic by construction. Per the "No-Do" constraint, it never
contains a runnable command line for the child to copy — see
`docs/architecture.md`.

### `dismiss` — engine → tutor

```json
{"v":1,"type":"dismiss","id":"01JB2Z..."}
```

Sent when the child moves on before the TTL expires (for example, a simulated
`SIGINT` reset).

### `feedback` — tutor → engine

```json
{"v":1,"type":"feedback","id":"01JB2Z...","verdict":"helpful","at":"2026-09-05T18:22:31Z"}
```

`verdict` is `helpful` or `confusing`. The engine matches `id` back to session
state and appends to telemetry asynchronously. A `feedback` for an unknown `id`
is dropped silently — the engine may have restarted.

### `ack` — tutor → engine

```json
{"v":1,"type":"ack","id":"01JB2Z...","rendered":true}
```

Optional. Lets the engine record that a hint actually reached a screen, which
is the difference between "the hint was unhelpful" and "the hint was never
seen" when reading telemetry.

## Versioning

`v` is the protocol major. A tutor that receives `v` greater than it
understands ignores the message. A breaking change bumps `v` and both sides
speak both versions for one release.
