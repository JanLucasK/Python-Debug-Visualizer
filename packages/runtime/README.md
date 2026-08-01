# python-debug-visualizer-runtime

The in-process half of the [Python Debug Visualizer](https://github.com/JanLucasK/python-debug-visualizer)
VS Code extension. It turns Python values into a compact binary description the
extension can plot.

**You normally do not need to install this.** The extension injects it into the
debuggee at the start of a debug session, so it works in virtualenvs,
containers and over SSH without anyone having to run `pip install`.

Install it explicitly only if you want to register adapters for your own types:

```python
import _pdv

@_pdv.register_adapter
class QuaternionAdapter(_pdv.Adapter):
    name = "myapp.Quaternion"

    def score(self, value):
        return 100 if isinstance(value, Quaternion) else 0

    def build(self, value, options):
        ...
```

Adapters are selected by score, so returning anything above 100 lets you take
over a type a built-in adapter also matches.

## Design constraints

This package runs inside somebody else's process while they are trying to
understand it. Two rules follow, and both are load-bearing:

- **No dependencies, and no imports of optional ones.** Integrations are
  discovered from `sys.modules`. Importing torch into a process that had not
  imported it can initialise CUDA and take seconds; importing anything changes
  the state of the program under debug.
- **Never raise.** `capture()` converts every failure into a structured
  response. An exception escaping into the debuggee would be a bug in a tool
  whose whole purpose is making bugs easier to find.

## Development

```bash
python -m pytest tests -q
```

MIT licensed.
