from __future__ import annotations

import base64
import hashlib
import json
import zlib
from pathlib import Path
from typing import Dict, List

import pytest

RUNTIME_ROOT = Path(__file__).resolve().parent.parent
SRC = RUNTIME_ROOT / "src"
BOOTSTRAP = RUNTIME_ROOT / "bootstrap" / "loader.py"


def collect_sources() -> Dict[str, List[object]]:
    """Map module name -> [source, is_package] for every module in the runtime.

    Mirrors what the extension's packer does at build time. The test builds its
    own copy on purpose: the packer is a few lines of file IO, while the loader
    it feeds is the part that can actually go wrong, and this keeps the loader
    test independent of the Node build.
    """
    sources: Dict[str, List[object]] = {}
    for path in sorted((SRC / "_pdv").rglob("*.py")):
        parts = list(path.relative_to(SRC).with_suffix("").parts)
        is_package = parts[-1] == "__init__"
        if is_package:
            parts = parts[:-1]
        sources[".".join(parts)] = [path.read_text(encoding="utf-8"), is_package]
    return sources


def build_bootstrap_expression() -> str:
    """Produce the exact single expression the extension evaluates in the debuggee."""
    from _pdv.version import RUNTIME_VERSION

    sources = json.dumps(collect_sources())
    packed = base64.b64encode(zlib.compress(sources.encode("utf-8"), 9)).decode("ascii")
    build = "{}+{}".format(
        RUNTIME_VERSION, hashlib.sha256(sources.encode("utf-8")).hexdigest()[:12]
    )

    loader = BOOTSTRAP.read_text(encoding="utf-8")
    loader = loader.replace("@@SOURCES@@", packed).replace("@@BUILD@@", build)

    blob = base64.b64encode(zlib.compress(loader.encode("utf-8"), 9)).decode("ascii")
    # The trailing `{}` gives exec its own globals, so the loader's module-level
    # names never reach the frame the user is paused in. See bootstrap/loader.py.
    return (
        'exec(__import__("zlib").decompress('
        '__import__("base64").b64decode("{}")).decode("utf-8"), {{}})'.format(blob)
    )


@pytest.fixture(scope="session")
def bootstrap_expression() -> str:
    return build_bootstrap_expression()


@pytest.fixture
def np():
    return pytest.importorskip("numpy")
