# Architecture

## The problem this shape solves

Getting a large NumPy array out of a paused Python process and onto a chart in a
webview crosses three process boundaries, each with its own failure mode. Most
of the design here is a response to a specific, verified constraint rather than
a preference.

| Boundary | Constraint | Response |
|---|---|---|
| debuggee → debug adapter | debugpy truncates evaluate results at 64 KiB (`SafeRepr.maxstring_outer = 2**16`) | Evaluate with `context: "clipboard"` **and** `format: {rawString: true}` |
| debug adapter → extension | The response is the *repr* of the value, so quotes and backslashes come back escaped | Encode the whole response as base64, whose alphabet repr never escapes |
| extension → webview | Under Remote-SSH the extension host is remote and the webview is local, so `localhost` differs | Never open a socket from the webview; push everything via `postMessage` |

### Why both truncation bypasses

Measured against debugpy 1.8.21 in
`packages/runtime/tests/test_dap_integration.py`, not taken on faith:

| context | `rawString` | 8 MB array |
|---|---|---|
| `repl` | absent | **truncated** to ~64 KiB — envelope undecodable |
| `clipboard` | absent | full |
| `repl` | set | full |
| `clipboard` | set | full |

Either bypass alone is sufficient today, so the extension sends both. `rawString`
is a debugpy extension to DAP with no specification behind it, and the clipboard
carve-out is one branch in pydevd; losing either one silently would produce a
*corrupted* plot rather than a missing one, which is the failure mode worth
spending a redundant request field on.

Clipboard context earns its place for a second reason: unlike `repl`, it does
not redirect the debuggee's stdout into the Debug Console, so installing the
runtime produces no output for the user to wonder about.

## Data flow

```
                       ┌─────────────────────────────────────────┐
  debuggee (python)    │  _pdv  (injected, no dependencies)      │
                       │    registry → adapter → Capture         │
                       │    descriptor (JSON) + channels (bytes) │
                       └────────────────┬────────────────────────┘
                                        │ envelope: b64(zlib(len‖json‖bytes))
                       DAP evaluate     │ context=clipboard
                                        ▼
                       ┌─────────────────────────────────────────┐
  extension host       │  SessionTracker → Evaluator             │
  (remote under SSH)   │  TransportSelector → ResolvedCapture    │
                       │  SnapshotStore (history, diff)          │
                       └────────────────┬────────────────────────┘
                                        │ postMessage(Uint8Array)
                                        ▼
                       ┌─────────────────────────────────────────┐
  webview (always      │  viz registry → uPlot / canvas / grid   │
  local)               │  stats strip, history scrubber          │
                       └─────────────────────────────────────────┘
```

## Bootstrapping

Once per debug session the extension evaluates a single expression:

```python
exec(__import__("zlib").decompress(__import__("base64").b64decode("...")).decode("utf-8"), {})
```

It carries the entire Python runtime, compressed. The loader installs a
`sys.meta_path` finder backed by an in-memory source map, so `import _pdv` works
without touching the filesystem — no temp files, no write permissions, nothing
left behind on a remote host.

Two properties of that one line are load-bearing, and both are covered by tests
in `packages/runtime/tests/test_bootstrap.py`:

- **It is an expression.** `exec(...)` is a function call, so it evaluates in
  eval-only DAP contexts too. Debug adapters differ in whether they permit
  statements; building on the narrowest capability means it works everywhere.
- **It passes an explicit `{}` as globals.** Otherwise `exec` runs against the
  caller's frame and injects its module-level names into whatever function the
  user is paused in. The debuggee's locals belong to the person debugging.

Afterwards everything is reached through `__import__("_pdv")`, which also keeps
the bootstrap from colliding with user variable names.

## Adapters

An adapter converts one family of Python values into a `Capture`. Selection is
by score, not by an isinstance chain, so a user-registered adapter can claim a
type a built-in also matches simply by scoring higher.

```
1        fallback — describes literally anything
10-40    built-ins — list, dict, scalars
50-90    library adapters shipped here — numpy, pandas, torch
100+     user adapters, which win by default
```

Adapters for optional libraries are registered as *lazy providers* keyed on a
module name, and only materialise once that module is already in `sys.modules`.
The runtime never imports numpy, pandas or torch itself. This is not an
optimisation: importing torch into a process that had not imported it can
initialise CUDA and cost seconds, and importing anything at all changes the
state of the program under debug.

## The honesty rules

A debugging tool that misleads you is worse than no tool. Three rules are
enforced by tests rather than by convention:

1. **Statistics describe the whole value, never the transferred subset.** A plot
   may show 2 000 of 200 000 points; the min/max beside it are still the real
   ones, including a spike decimation dropped.
2. **Decimation is visible.** The descriptor carries the method and both
   lengths, and the UI shows it.
3. **Gaps survive.** When a float series contains NaN or Inf, decimation
   switches from LTTB to min/max, because LTTB would quietly close the gaps and
   make a broken series look continuous.

The corresponding anti-pattern is real: another extension in this space silently
coerces NaN and Inf to zero before plotting.

## Comparing captures

History lives in the webview rather than the extension host. It already receives
every capture, so keeping the last *N* there costs one array and no protocol
surface at all; the tradeoff is that history does not survive a webview reload,
which is a fair price for not inventing a second store.

The part that needs care is alignment. Two captures of the same expression at
different steps may have been decimated differently — LTTB picks whichever
points best preserve *that* curve — so element 500 of one and element 500 of the
other are usually not the same element of the underlying array. Subtracting them
by position yields a confident, entirely fictional delta.

Comparison therefore runs on x positions, which is the reason the runtime sends
them explicitly whenever decimation occurred. Points present on only one side
are counted as unmatched rather than compared against nothing, and a NaN on
either side produces a NaN delta instead of a change of zero — a gap is not a
measurement.

The same problem shows up in rendering. uPlot requires one shared x array for
all series, so overlaying a pinned capture builds the union of both axes and
projects each series onto it with gaps where it has no point. Handing it the
current x array and the pinned values would reproduce exactly the misalignment
the diff avoids, except silently and on screen.

## Transports

Bulk bytes reach the extension host by one of three routes, chosen by size and
by what the topology allows.

| | When | Notes |
|---|---|---|
| `inline` | below 64 KB | Rides in the evaluate response. One round trip, works everywhere |
| `socket` | above that | Debuggee dials a loopback listener in the extension host. Safe under Remote-SSH and dev containers, because both run on the same machine there |
| `file` | loopback failed | Debuggee and extension host in *different* containers sharing a volume |

They are tried in that order and every failure falls through to the next, with
`inline` as the floor — a slow plot beats no plot, so a transport problem never
becomes a failed capture.

Two details are load-bearing. The token is reserved *before* the capture is
evaluated, because the debuggee can connect and finish sending while the
evaluate response is still in flight; registering afterwards loses that race
intermittently, which is the worst way for it to fail. And the sender blocks
until the listener acknowledges, so a discarded socket cannot drop buffered
bytes — which also means anything driving both sides must not block the event
loop doing the acknowledging.

Both halves of the framing were written from the same description, and a
description is not a guarantee: a wrong offset or endianness would produce
plausible numbers rather than an error. `PayloadServer.test.ts` runs the real
Python transport against the real listener, up to five megabytes.

The webview is deliberately unaware of all of this — it receives a
`ResolvedCapture` with plain bytes — which is what kept adding two transports
from touching the UI at all.

## Protocol versioning

`PROTOCOL_VERSION` appears in `packages/protocol/src/descriptor.ts` and in
`packages/runtime/src/_pdv/version.py` and must match. The extension refuses a
capture whose version it does not recognise rather than guessing: a
half-understood descriptor produces a plot that is wrong rather than absent, and
wrong is worse.

## Milestones

| | Scope | State |
|---|---|---|
| M0 | Monorepo, protocol, runtime, injection | done |
| M1 | Bootstrapper, evaluator, inline transport, numpy 1-D → line | done |
| M2 | pandas / torch / tf adapters, remaining visualizations | done |
| M3 | Snapshot, diff, history scrubber | done |
| M4 | Socket transport, zoom-triggered refetch | |
| M5 | Multi-pane, remote hardening, publish | |

## Where visualizations are decided

Three separate questions, deliberately answered in different places:

- **What can this value support?** The webview's viz registry, from the
  descriptor's kind, shape and statistics — never from the channels the current
  capture happens to carry. A histogram capture contains bin counts instead of
  points, so a channel-based test would hide every other option the moment one
  was picked, with no way back.
- **What should it show by default?** The Python adapter, via
  `Descriptor.suggestedViz`. It is the side that just looked at the value.
- **What is actually shown?** The user's per-pane choice, which overrides both.

Some visualizations are *reductions* rather than views. A histogram needs bin
counts, and computing those in the debuggee is what keeps five million points
from crossing the wire to draw sixty bars — so the selected kind travels to
Python, and adapters that care about it branch on `options["viz"]`.
