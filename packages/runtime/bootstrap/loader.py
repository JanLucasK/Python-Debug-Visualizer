"""Bootstrap loader, executed once per debug session inside the debuggee.

The extension compresses this file (with the two placeholder tokens filled in)
and evaluates it as::

    exec(__import__("zlib").decompress(__import__("base64").b64decode("...")).decode("utf-8"), {})

Two details of that line are load-bearing.

``exec(...)`` is a *function call*, therefore an expression, therefore evaluable
in every DAP context — including the eval-only ones. Debug adapters differ in
whether they let you run statements, and building on the narrowest capability
means the tool works everywhere rather than only where we got lucky.

The trailing ``{}`` is the globals namespace, and it is not optional. Without
it, ``exec`` runs against the *caller's* frame, so every module-level name
below would be injected into whatever function the user happens to be paused
in. The debuggee's locals belong to the person debugging; a tool that adds
variables to the scope they are inspecting is corrupting the evidence. With an
explicit dict, the only lasting effect is the entry in ``sys.modules``, reached
afterwards via ``__import__("_pdv")``.

Sources are served from an in-memory finder rather than written to disk: no
temp files to clean up, no write permissions needed, and nothing left behind on
a remote host.
"""

_PDV_SOURCES_B64 = "@@SOURCES@@"

#: Identifies the exact *code* being injected: the release version plus a hash
#: of the packed sources.
#:
#: Deliberately not the release version on its own. A debug session installs the
#: runtime once and keeps it; if the marker only changed when someone remembered
#: to bump a version string, an edited runtime would never reach a session that
#: was already running, and the symptom is a new feature that silently does
#: nothing until the whole session is restarted. Deriving it from the content
#: means any change to any source file replaces the installed copy.
_PDV_BUILD = "@@BUILD@@"


def _pdv_bootstrap():
    import base64
    import importlib.abc
    import importlib.util
    import json
    import sys
    import zlib

    existing = sys.modules.get("_pdv")
    if existing is not None and getattr(existing, "__pdv_build__", None) == _PDV_BUILD:
        return  # this exact code is already installed

    if existing is not None:
        # Different code is loaded, from an earlier session or a pip install.
        # Evict it wholesale; a half-replaced package is worse than either.
        for name in [n for n in sys.modules if n == "_pdv" or n.startswith("_pdv.")]:
            del sys.modules[name]

    sources = json.loads(zlib.decompress(base64.b64decode(_PDV_SOURCES_B64)).decode("utf-8"))

    class _PdvLoader(importlib.abc.Loader):
        def create_module(self, spec):
            return None  # use the default module object

        def exec_module(self, module):
            source, _is_package = sources[module.__name__]
            code = compile(source, "<pdv:{}>".format(module.__name__), "exec")
            exec(code, module.__dict__)

    class _PdvFinder(importlib.abc.MetaPathFinder):
        def find_spec(self, fullname, path=None, target=None):
            entry = sources.get(fullname)
            if entry is None:
                return None
            return importlib.util.spec_from_loader(
                fullname, _PdvLoader(), is_package=bool(entry[1])
            )

        # Python 2 era API that some debuggers still probe for.
        def find_module(self, fullname, path=None):  # pragma: no cover
            return None

    sys.meta_path.insert(0, _PdvFinder())
    # Stamped by the loader rather than baked into a source file, so the runtime
    # does not have to know a hash of itself.
    __import__("_pdv").__pdv_build__ = _PDV_BUILD


_pdv_bootstrap()
