# Proposal: a real sandbox instead of the in-memory VFS

**Status: open.** This is input for the engine developer and the repo owner, not
a decision. It is recorded as D20 in [`../decisions.md`](../decisions.md) with
status *Proposed*.

## The proposal

From the engine developer:

> I would prefer to use a real sandbox strategy instead of simulating the
> filesystem. This should let us use system apps instead of rewriting them
> ourselves as well. My sandbox goal is that the shell and anything it runs is
> bound to the sandbox rules.

That is not "put the current engine in a jail". The child's commands never touch
the disk today; they are evaluated against an in-memory VFS, which
[`../architecture.md`](../architecture.md) §1 names as the thing that makes the
engine deterministic. The proposal replaces that core: real programs running
against a real directory tree, inside an operating-system sandbox that binds
everything they spawn.

The VFS was never argued for in a decision entry, so there is no recorded reason
to defend. The challenge is fair and this document tries to weigh it that way.

## What was measured

`scripts/sandbox-spike.sh` builds the Lighthouse scenario in a temporary
directory, mounts it as `/` inside bubblewrap with only `ls`, `cat` and `pwd`
bound, and runs it as an ordinary user. Output from 2026-09-13, on Arch Linux,
kernel 7.2.3, coreutils 9.11, bubblewrap 0.12.0, verbatim:

```
== 1. runs without root
host uid 1000; bubblewrap 0.12.0; everything below ran as that uid

== 2. what the child can see

$ pwd
/
[exit 0]

$ ls
lib64
lighthouse
rocks
usr
[exit 0]

$ ls -a /
.
..
lib64
lighthouse
rocks
usr
[exit 0]

== 3. real stderr for slots the dictionary already has

$ ls lighthosue
ls: cannot access 'lighthosue': No such file or directory
[exit 2]

$ cat lighthouse
cat: lighthouse: Is a directory
[exit 1]

$ cat
[exit 0]

$ notacommand
bwrap: execvp notacommand: No such file or directory
[exit 1]

== 4. the host is out of reach

$ cat /etc/hostname
cat: /etc/hostname: No such file or directory
[exit 1]

$ ls /home
ls: cannot access '/home': No such file or directory
[exit 2]
```

Also checked on the same machine:

- Unprivileged user namespaces are enabled (`kernel.unprivileged_userns_clone =
  1`) and Landlock is an active LSM.
- bubblewrap is installed only as a transitive dependency (`glycin` →
  `gdk-pixbuf2`). A package relying on it has to declare it.
- `cd` is a shell builtin. There is no `/usr/bin/cd`.
- Bare `cd` in real bash exits 0 and moves to `$HOME`. Bare `ls` exits 0.
- No non-English locale is installed, so translated error text could not be
  shown here. That coreutils messages are translated is standard gettext
  behaviour, but it is not demonstrated by this spike.

## Findings

### 1. It works without root, and it is a real boundary

The first two goals are met outright. An ordinary user got a private world with
`/` at the top of the scenario, and the host was unreachable: no `/etc`, no
`/home`. "Anything it runs is bound" holds, because bubblewrap's namespaces are
inherited by every child process.

### 2. Two of the dictionary's slots describe errors real Linux does not have

This is the most important result, and it supports the proposal's premise.

`slots.json` defines `cd/Bad_Usage` as `flish: cd: expected one folder name`
and `cat/Bad_Usage` as `flish: cat: expected one file name`. Neither error
exists. Real `cd` with no argument goes home and succeeds. Real `cat` with no
argument exits 0, because it reads standard input.

So the simulation teaches a child two errors they will never see on a real
machine. That is exactly the divergence the developer is worried about, and it
was invisible until something real was run next to it. Nine candidates in the
review queue are built on those two slots.

It also cuts the other way. Under a real sandbox, a child who types `cat` and
presses Enter does not get an error. They get a terminal that silently waits for
the keyboard. Nothing failed, so there is no strike and no hint, and a
seven-year-old has no reason to know about Ctrl-D.

### 3. Host programs cannot be hidden from the child's world

`ls` at the root shows `lib64` and `usr` next to `lighthouse` and `rocks`. Host
coreutils are dynamically linked, so the loader and libc must be visible at the
paths the binary was built for. Dropping `/proc` and `/dev` removed those two
entries. These two cannot be removed while the programs are host binaries.

The curated island is the teaching surface: every name in it is chosen, and the
hints are written against it. With host binaries, part of every world is
`/usr/lib` — thousands of names the lesson did not put there.

### 4. The error text mostly survives, the prefix does not

Real `ls` and `cat` produce the messages the dictionary already models, minus
the `flish:` prefix, with different exit codes per program (2 for `ls`, 1 for
`cat`). The unknown-command text comes from whatever launched the process —
`bwrap: execvp …` here, `bash: …: command not found` in a real shell — so the
engine owns that message under either design.

## What it costs

**Determinism has to be engineered (D1).** "The same mistake always yields the
same hint" is the product's central promise. With host programs, error text
follows the host's coreutils version and locale. A coreutils update that
rewords one message stops one hint firing, and nothing reports it, because no
hint is the designed failure mode. The VFS got determinism for free. A sandbox
gets it by pinning the programs and forcing `LC_ALL=C`.

**Status becomes something the engine parses.** Slots key on `(command,
Status)`, and the engine assigns Status today. Under the proposal it is
recovered from the exit code and stderr of programs someone else wrote. That
classifier becomes the core of the engine. It is D2's open regex decision, once
per program. `slot-drift.test.js` currently takes its ground truth from
`commands.odin`; that source goes away and the slot list has to come from the
classifier's table instead.

**Safety the VFS provides by construction has to be added.** A filesystem
boundary does not stop a fork bomb, `yes > f` filling the disk, a CPU-bound
loop, or network access. Nor does it stop `vim`, `less` or `top` taking over the
terminal. That is the same stuck-with-no-failure state as bare `cat`, and just
as invisible to the hint system. A real sandbox needs process and memory limits
(cgroups or rlimits), a network namespace, a size-capped writable tree, a reset
per session, and an allowlist of programs rather than a bind of `/usr`.

**Landlock is not enough on its own.** It restricts access, is inherited by
everything spawned, and needs no root — an exact fit for "anything it runs is
bound". But it does not change what paths look like. `pwd` would print the real
host path, and the Lighthouse starts the child at `/`. A clean root needs a
mount namespace. Landlock fits as a second layer inside bubblewrap.

**Portability.** Arch and Omarchy allow unprivileged user namespaces. Ubuntu
24.04 and later restrict them through AppArmor; bubblewrap ships a profile that
permits it, a hand-rolled `unshare` wrapper does not. This matters once the
GNOME frontend in D5 exists.

## What survives either way

Most of the hint pipeline does not care how Status is produced. The dictionary,
the schema, every gate rule, `draft.py`, `review.py`, the IPC protocol and the
tutor overlay all key on `(command, Status)` plus decorators.

- **Scenarios** become seeds written into the sandbox at session start. The spike
  already does this from the JSON as it stands.
- **Decorators** keep their meaning. They are computed from `stat` and `readdir`
  instead of VFS nodes, and `tests/helpers/matcher.js` remains their
  specification.
- **Changes:** the builtins other than `cd`, the `flish:` prefix in `slots.json`,
  where the slot list comes from, and the two `Bad_Usage` slots, which have no
  real counterpart.

## Recommendation

**A real sandbox, with a pinned, statically linked toolset instead of host
programs.**

That meets all three stated goals: real programs, no rewriting, and a boundary
around everything spawned. It also answers findings 2 and 3 and keeps D1.

- **Static binaries** need no loader or libc, so nothing but the programs
  themselves has to appear in the child's world. Finding 3 goes away. They can
  live under one directory on `PATH`, hidden with a dot name if wanted.
- **Pinned** means the error text changes only when the project updates the
  toolset. The classifier's table is versioned with it, so a reworded message
  shows up as a diff in review instead of a hint that silently stops.
- **`LC_ALL=C`** inside the sandbox fixes the language of every message.
- **`cd` stays a builtin in the engine**, a real `chdir` inside the namespace,
  because it cannot be anything else.
- **Bare `cat` and other stdin readers** need a decision before anything ships.
  Either the engine closes stdin for programs not meant to be interactive, or it
  treats "running with no output for N seconds" as a stuck signal the hint system
  can see.

The honest trade is which static toolset to pin. BusyBox is small and a single
binary, but its messages differ from GNU coreutils, so "authentic" would mean
authentic to BusyBox, not to the machine the child uses next. A statically built
coreutils subset keeps the GNU text at the cost of a larger payload and a build
step. That choice belongs to the developer.

## Open questions for the developer

1. Is the "shell" the Odin REPL spawning real programs, or a real shell such as
   bash running inside the sandbox? A real shell moves the REPL out of the
   engine, so strike tracking would have to watch from outside.
2. BusyBox or a static coreutils subset?
3. How should a program waiting on the keyboard with no output become visible to
   the hint system?
4. Should the two `Bad_Usage` slots be retired now, before review spends time on
   them? They teach errors that do not exist, whichever design wins.
