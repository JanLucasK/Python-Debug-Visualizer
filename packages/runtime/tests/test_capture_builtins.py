from __future__ import annotations

import struct

import pytest

from _pdv import extract as capture_module
from _pdv import envelope
from _pdv.errors import CaptureError
from _pdv.registry import Adapter, Registry


def decode_capture(value):
    return envelope.decode(capture_module.capture(value))


def test_scalar():
    document, payload = decode_capture(42)
    assert document["descriptor"]["kind"] == "scalar"
    assert document["descriptor"]["stats"]["mean"] == 42.0
    assert payload == b""


def test_none_and_str_have_no_stats():
    for value in (None, "hello"):
        document, _ = decode_capture(value)
        assert document["descriptor"]["kind"] == "scalar"
        assert document["descriptor"]["stats"] is None


def test_numeric_list_becomes_a_line():
    document, payload = decode_capture([1.0, 2.0, 4.0])
    assert document["descriptor"]["kind"] == "sequence"
    assert document["descriptor"]["suggestedViz"][0] == "line"
    assert struct.unpack("<3d", payload) == (1.0, 2.0, 4.0)


def test_mixed_list_falls_back_to_structure():
    document, payload = decode_capture([1.0, "two", 3.0])
    assert document["descriptor"]["channels"] == []
    assert "non-numeric" in " ".join(document["warnings"])
    assert payload == b""


def test_dict_is_described_not_plotted():
    document, _ = decode_capture({"a": 1})
    assert document["descriptor"]["kind"] == "mapping"
    assert document["descriptor"]["suggestedViz"] == ["tree"]


def test_arbitrary_object_never_fails():
    class Weird:
        def __repr__(self):
            raise RuntimeError("no repr for you")

    document, _ = decode_capture(Weird())
    assert document["ok"] is True
    assert "repr failed" in document["descriptor"]["preview"]


def test_pathological_repr_is_truncated():
    class Huge:
        def __repr__(self):
            return "x" * 100_000

    document, _ = decode_capture(Huge())
    assert len(document["descriptor"]["preview"]) <= 300


def test_adapter_failure_is_reported_not_raised():
    """A broken adapter must produce an error card, not an exception in the debuggee."""

    class Exploding(Adapter):
        name = "exploding"

        def score(self, value):
            return 1000 if value == "boom" else 0

        def build(self, value, options):
            raise ValueError("adapter is broken")

    capture_module.registry.register(Exploding())
    try:
        document, _ = decode_capture("boom")
        assert document["ok"] is False
        assert document["error"]["type"] == "ValueError"
        assert document["error"]["traceback"] is not None
    finally:
        capture_module.registry._adapters.remove(capture_module.registry._adapters[-1])


def test_capture_error_carries_its_kind():
    class Refusing(Adapter):
        name = "refusing"

        def score(self, value):
            return 1000 if value == "nope" else 0

        def build(self, value, options):
            raise CaptureError("Unsupported", "cannot do that")

    capture_module.registry.register(Refusing())
    try:
        document, _ = decode_capture("nope")
        assert document["error"]["type"] == "Unsupported"
        assert document["error"]["message"] == "cannot do that"
    finally:
        capture_module.registry._adapters.remove(capture_module.registry._adapters[-1])


def test_higher_score_wins():
    registry = Registry()

    class Low(Adapter):
        name = "low"

        def score(self, value):
            return 10

        def build(self, value, options):
            raise AssertionError("should not be selected")

    class High(Adapter):
        name = "high"

        def score(self, value):
            return 20

        def build(self, value, options):
            raise AssertionError("not called in this test")

    registry.register(Low())
    registry.register(High())
    assert registry.resolve(object()).name == "high"


def test_adapter_raising_in_score_is_skipped():
    registry = Registry()

    class Broken(Adapter):
        name = "broken"

        def score(self, value):
            raise RuntimeError("score exploded")

        def build(self, value, options):
            raise AssertionError

    class Fine(Adapter):
        name = "fine"

        def score(self, value):
            return 5

        def build(self, value, options):
            raise AssertionError

    registry.register(Broken())
    registry.register(Fine())
    assert registry.resolve(object()).name == "fine"


def test_lazy_provider_only_runs_once_module_is_imported():
    registry = Registry()
    calls = []

    def provider(reg):
        calls.append(True)

    registry.register_lazy("a_module_that_does_not_exist", provider)
    registry.resolve(object())
    assert calls == [], "provider ran before its module was imported"


def test_elapsed_ms_is_reported():
    document, _ = decode_capture([1.0, 2.0])
    assert document["elapsedMs"] >= 0.0
