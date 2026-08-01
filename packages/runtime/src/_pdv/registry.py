"""Adapter registry.

An adapter turns one family of Python values into a :class:`Capture`. Selection
is by score rather than by isinstance chains, so a third-party adapter can claim
a type that a built-in also matches simply by scoring higher — no monkeypatching
and no ordering assumptions.

The other half of the design is laziness. Adapters for optional libraries are
registered as *providers* keyed by module name and are only materialised once
that module already appears in ``sys.modules``. We never import numpy, pandas or
torch ourselves: importing torch into a process that had not imported it can
initialise CUDA and cost seconds, and importing anything at all changes the
behaviour of the program under debug.
"""

from __future__ import annotations

import sys
from typing import Any, Callable, Dict, List, Optional, Tuple

from .descriptor import Capture


class Adapter:
    """Base class for value adapters."""

    #: Stable identifier, surfaced in diagnostics.
    name: str = "adapter"

    def score(self, value: Any) -> int:
        """Return how well this adapter fits ``value``; 0 means "cannot handle".

        Conventional bands:

        =========  ======================================================
        1          last-resort fallback
        10-40      generic built-ins (list, dict, scalars)
        50-90      library-specific adapters shipped with the runtime
        100+       user-registered adapters, which should win by default
        =========  ======================================================
        """
        raise NotImplementedError

    def build(self, value: Any, options: Dict[str, Any]) -> Capture:
        """Produce the capture. May raise; the caller converts it to an error."""
        raise NotImplementedError


ProviderFn = Callable[["Registry"], None]


class Registry:
    def __init__(self) -> None:
        self._adapters: List[Adapter] = []
        self._providers: List[Tuple[str, ProviderFn]] = []

    def register(self, adapter: Adapter) -> Adapter:
        """Register an adapter immediately. Returns it, so it can be used as a decorator."""
        self._adapters.append(adapter)
        return adapter

    def register_lazy(self, module_name: str, provider: ProviderFn) -> None:
        """Register ``provider`` to run the first time ``module_name`` is imported by the debuggee.

        Re-checked on every capture, so attaching to a process before it imports
        pandas still gives you pandas support once it gets there.
        """
        self._providers.append((module_name, provider))

    def _materialize(self) -> None:
        if not self._providers:
            return
        pending = self._providers
        self._providers = []
        for module_name, provider in pending:
            if module_name not in sys.modules:
                self._providers.append((module_name, provider))
                continue
            try:
                provider(self)
            except Exception:
                # A broken optional adapter must not take down capture for
                # everything else; drop it and carry on with what works.
                pass

    def resolve(self, value: Any) -> Optional[Adapter]:
        self._materialize()
        best: Optional[Adapter] = None
        best_score = 0
        for adapter in self._adapters:
            try:
                score = adapter.score(value)
            except Exception:
                continue
            if score > best_score:
                best, best_score = adapter, score
        return best

    def adapter_names(self) -> List[str]:
        self._materialize()
        return [a.name for a in self._adapters]


#: Process-wide registry. There is exactly one debuggee, so a module global is
#: the honest representation.
registry = Registry()


def register_adapter(adapter: Adapter) -> Adapter:
    """Public hook for user-defined adapters."""
    return registry.register(adapter)
