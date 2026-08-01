# Architecture

## The problem this shape solves

Getting a large NumPy array out of a paused Python process and onto a chart in a
webview crosses three process boundaries, each with its own failure mode. Most
of the design here is a response to a specific, verified constraint rather than
a preference.

| Boundary | Constraint | Response |
|---|---|---|
| debuggee → debug adapter | debugpy truncates evaluate results at 64 KiB (`SafeRepr.maxstring_outer = 2**16`) | Evaluate with `context: "clipboard"`, where debugpy raises the limit to `2**64` |
| debug adapter → extension | The response is the *repr* of the value, so quotes and backslashes come back escaped | Encode the whole response as base64, whose alphabet repr never escapes |
| extension → webview | Under Remote-SSH the extension host is remote and the webview is local, so `localhost` differs | Never open a socket from the webview; push everything via `postMessage` |

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

## Transports

Bulk bytes reach the extension host by one of three routes, chosen by size and
by what the topology allows.

| | When | Notes |
|---|---|---|
| `inline` | below ~48 KB | Rides in the evaluate response. One round trip, works everywhere |
| `socket` | large payloads | Debuggee dials back to a loopback listener in the extension host. Safe under Remote-SSH and dev containers, because both run on the same machine there |
| `file` | loopback unavailable | Debuggee and extension host in *different* containers sharing a volume |

Only `inline` exists today; `socket` and `file` arrive in M4. The webview is
deliberately unaware of all of this — it receives a `ResolvedCapture` with plain
bytes — so adding transports does not ripple into the UI.

## Protocol versioning

`PROTOCOL_VERSION` appears in `packages/protocol/src/descriptor.ts` and in
`packages/runtime/src/_pdv/version.py` and must match. The extension refuses a
capture whose version it does not recognise rather than guessing: a
half-understood descriptor produces a plot that is wrong rather than absent, and
wrong is worse.

## Milestones

| | Scope | State |
|---|---|---|
| M0 | Monorepo, protocol, runtime, injection | runtime and protocol done |
| M1 | Bootstrapper, evaluator, inline transport, numpy 1-D → line | in progress |
| M2 | pandas / torch / tf adapters, remaining visualizations | |
| M3 | Snapshot, diff, history scrubber | |
| M4 | Socket transport, zoom-triggered refetch | |
| M5 | Multi-pane, remote hardening, publish | |
