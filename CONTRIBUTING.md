# Contributing

## Getting set up

```bash
pnpm install
pnpm build

python -m venv .venv
.venv/bin/pip install -e "packages/runtime[dev]"
```

Press `F5` for an Extension Development Host, then follow
[examples/README.md](examples/README.md) to exercise everything.

```bash
pnpm lint && pnpm typecheck && pnpm test
.venv/bin/python -m pytest packages/runtime/tests -q
```

If VS Code tasks report `pnpm: command not found`, see the note in the
[README](README.md#if-vs-code-tasks-report-pnpm-command-not-found) — version
managers that install into `~/.bashrc` are invisible to task shells.

## What this project cares about

There is one rule that outranks the rest, and most of the design follows from
it: **a debugging tool that misleads you is worse than no tool.**

In practice that means:

- Statistics describe the *whole* value, never the subset that was transferred.
  Downsampling and zooming must not change what they mean.
- Anything dropped, skipped, rounded, stretched or truncated is said out loud.
  A silently missing column is indistinguishable from a bug in the user's own
  code.
- Gaps stay gaps. NaN means "no value here", and joining across one invents a
  line the data does not support.
- Nothing may raise into the debuggee. It is somebody's program, being debugged.

If a change makes one of these harder to hold, that is worth discussing in the
issue before writing the code.

## Where things live

| Package | |
|---|---|
| `packages/protocol` | Wire types shared by all three sides |
| `packages/runtime` | Python, runs inside the debuggee. **No dependencies** |
| `packages/extension` | Extension host: debug session, transports, panels |
| `packages/webview` | UI: Preact, uPlot, canvas |

[docs/architecture.md](docs/architecture.md) explains why the shape is what it
is — most of it is a response to a measured constraint rather than a preference.

## Tests

The suite leans on real things rather than fixtures, because the interesting
failures live at boundaries:

- `test_dap_integration.py` drives an actual debugpy session.
- The extension's envelope and transport tests round-trip through real Python.
- The webview constructs a real uPlot against a DOM.
- `test_examples.py` checks that the guide's claims are still true.

That is deliberate. A mocked boundary tests what we believe the other side does,
and several bugs here were exactly that belief being wrong.

## Adding an adapter

Adapters convert one family of Python values into a capture. They are selected
by score, so a new one can claim a type a built-in also matches:

```python
@_pdv.register_adapter
class QuaternionAdapter(_pdv.Adapter):
    name = "myapp.Quaternion"

    def score(self, value):
        return 100 if isinstance(value, Quaternion) else 0

    def build(self, value, options):
        ...
```

Adapters for third-party libraries register *lazily*, keyed on a module name,
and materialise only once the debuggee has imported it. The runtime never
imports numpy, pandas or torch itself: importing torch into a process that had
not imported it can initialise CUDA and cost seconds, and importing anything
changes the state of the program under debug.

An adapter that produces series must honour `options["range"]` — see
`_pdv.window`. Forgetting it makes zooming silently do nothing, which looks like
a broken zoom rather than a missing feature. There is a table test that catches
it.

## Commits and releases

Commit messages explain *why*, since the diff already shows what.

Releases are cut by tagging `vX.Y.Z` after bumping
`packages/extension/package.json`. The workflow re-runs the whole suite, checks
the tag against the manifest, and publishes to both the Marketplace and Open
VSX. A published version can be overwritten but never withdrawn, so it is worth
installing the VSIX and walking through the demo first.
