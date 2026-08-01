"""Tests for the TensorFlow adapter, against a stand-in for TensorFlow.

TensorFlow is a several-hundred-megabyte dependency, and none of the behaviour
worth testing here belongs to it. What can go wrong is *our* branching: whether
the adapter is picked at all, whether an eager tensor reaches the NumPy
builders, and whether a symbolic tensor — one inside a traced `tf.function`,
which holds no values — produces an explanation instead of a crash.

A stub with the same surface exercises all of that. It does not prove the
adapter works against real TensorFlow, and that gap is deliberate rather than
overlooked: it is covered by the shared NumPy path, which is tested thoroughly.
"""

from __future__ import annotations

import sys
import types

import pytest

from _pdv import envelope
from _pdv import extract as capture_module
from _pdv.registry import Registry

np = pytest.importorskip("numpy")


class FakeTensor:
    """Eager tensor: carries values and converts with `.numpy()`."""

    def __init__(self, array):
        self._array = np.asarray(array)
        self.shape = self._array.shape
        self.dtype = self._array.dtype

    def numpy(self):
        return self._array

    def __repr__(self):
        return "<tf.Tensor: shape={}>".format(self.shape)


class FakeSymbolicTensor:
    """Graph tensor: a node, with no value to read."""

    def __init__(self, shape):
        self.shape = shape
        self.dtype = "float32"

    def __repr__(self):
        return "<tf.Tensor 'x:0' shape={} dtype=float32>".format(self.shape)


class FakeVariable(FakeTensor):
    pass


@pytest.fixture
def tensorflow_stub():
    module = types.ModuleType("tensorflow")
    # Both real classes share a base in TensorFlow; here a tuple is enough for
    # the isinstance checks the adapter performs.
    module.Tensor = (FakeTensor, FakeSymbolicTensor)
    module.Variable = FakeVariable

    sys.modules["tensorflow"] = module
    try:
        yield module
    finally:
        del sys.modules["tensorflow"]


@pytest.fixture
def registry(tensorflow_stub):
    from _pdv.adapters import tensorflow_

    fresh = Registry()
    tensorflow_.install(fresh)
    return fresh


def capture_with(registry, value):
    adapter = registry.resolve(value)
    assert adapter is not None, "no adapter claimed the value"
    return adapter.build(value, {})


def test_adapter_claims_eager_tensors(registry):
    assert registry.resolve(FakeTensor([1.0, 2.0])) is not None


def test_adapter_claims_variables(registry):
    assert registry.resolve(FakeVariable([1.0])) is not None


def test_eager_tensor_reaches_the_numpy_builders(registry):
    capture = capture_with(registry, FakeTensor([1.0, 2.0, 3.0]))

    assert capture.descriptor.stats is not None
    assert capture.descriptor.stats.max == 3.0
    assert [c.name for c in capture.descriptor.channels] == ["y"]


def test_it_reports_the_tensorflow_type_not_the_ndarray(registry):
    capture = capture_with(registry, FakeTensor([1.0]))
    assert "FakeTensor" in capture.descriptor.python_type


def test_symbolic_tensor_explains_why_there_is_nothing_to_plot(registry):
    capture = capture_with(registry, FakeSymbolicTensor((None, 32)))

    assert capture.descriptor.channels == []
    message = " ".join(capture.warnings)
    assert "symbolic" in message and "tf.function" in message


def test_symbolic_tensor_shape_drops_unknown_dimensions(registry):
    # A batch dimension is None until the graph runs; reporting it as a number
    # would be inventing one.
    capture = capture_with(registry, FakeSymbolicTensor((None, 32)))
    assert capture.descriptor.shape == [32]


def test_a_tensor_whose_numpy_call_fails_is_reported_not_raised(registry):
    class Exploding(FakeTensor):
        def numpy(self):
            raise NotImplementedError("cannot read inside a traced function")

    capture = capture_with(registry, Exploding([1.0]))
    assert capture.descriptor.channels == []
    assert "Could not read" in " ".join(capture.warnings)


def test_adapter_is_absent_when_tensorflow_is_not_imported():
    """The lazy registration contract: no TensorFlow in sys.modules, no adapter."""
    assert "tensorflow" not in sys.modules

    from _pdv.adapters.tensorflow_ import TensorFlowAdapter

    assert TensorFlowAdapter().score(object()) == 0


def test_capture_end_to_end_through_the_registry(tensorflow_stub):
    """The real entry point, with the stub visible to the global registry."""
    document, payload = envelope.decode(capture_module.capture(FakeTensor([1.0, 2.0, 3.0])))

    assert document["ok"] is True
    assert document["descriptor"]["stats"]["count"] == 3
    assert len(payload) > 0
