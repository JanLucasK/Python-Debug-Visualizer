from __future__ import annotations

import base64
import json
import struct

import pytest

from _pdv import envelope
from _pdv import extract as capture_module

torch = pytest.importorskip("torch")


def capture(value, **options):
    encoded = (
        base64.b64encode(json.dumps(options).encode("utf-8")).decode("ascii") if options else ""
    )
    return envelope.decode(capture_module.capture(value, encoded))


def channels(document):
    return {c["name"]: c for c in document["descriptor"]["channels"]}


def read(document, payload, name):
    meta = channels(document)[name]
    fmt = {"f32": "f", "f64": "d", "i64": "q", "i32": "i", "u8": "B", "bool": "B"}[meta["dtype"]]
    raw = payload[meta["byteOffset"] : meta["byteOffset"] + meta["byteLength"]]
    return list(struct.unpack("<{}{}".format(meta["length"], fmt), raw))


def test_tensor_plots_like_an_array():
    document, payload = capture(torch.tensor([1.0, 2.0, 3.0]))

    assert read(document, payload, "y") == [1.0, 2.0, 3.0]
    assert document["descriptor"]["suggestedViz"][0] == "line"


def test_it_says_tensor_not_ndarray():
    """The conversion is an implementation detail; the user asked about a tensor."""
    document, _ = capture(torch.tensor([1.0, 2.0]))

    assert document["descriptor"]["pythonType"] == "torch.Tensor"
    assert document["descriptor"]["dtype"] == "float32"


def test_a_tensor_requiring_grad_is_readable():
    """`.numpy()` refuses outright on a tensor attached to the autograd graph.

    Since the tensors worth inspecting mid-training are exactly the ones with
    gradients, failing here would miss the main use case.
    """
    weights = torch.tensor([1.0, 2.0, 3.0], requires_grad=True)
    document, payload = capture(weights)

    assert document["ok"] is True
    assert read(document, payload, "y") == [1.0, 2.0, 3.0]
    # Reading must not detach the caller's tensor from the graph.
    assert weights.requires_grad is True


def test_reading_does_not_disturb_the_tensor():
    original = torch.tensor([1.0, 2.0, 3.0])
    capture(original)
    assert original.tolist() == [1.0, 2.0, 3.0]
    assert original.dtype is torch.float32


def test_bfloat16_widens_rather_than_failing():
    """NumPy has no bfloat16 at all, and JavaScript has neither half format."""
    document, payload = capture(torch.tensor([1.5, -2.5], dtype=torch.bfloat16))

    assert document["ok"] is True
    assert document["descriptor"]["dtype"] == "bfloat16"
    assert channels(document)["y"]["dtype"] == "f32"
    assert read(document, payload, "y") == [1.5, -2.5]


def test_float16_widens_too():
    document, payload = capture(torch.tensor([1.5, -2.5], dtype=torch.float16))
    assert channels(document)["y"]["dtype"] == "f32"
    assert read(document, payload, "y") == [1.5, -2.5]


def test_2d_tensor_suggests_a_heatmap():
    document, _ = capture(torch.arange(12, dtype=torch.float32).reshape(3, 4))
    assert document["descriptor"]["shape"] == [3, 4]
    assert document["descriptor"]["suggestedViz"][0] == "heatmap"


def test_integer_and_bool_tensors():
    document, payload = capture(torch.tensor([1, 2, 3], dtype=torch.int32))
    assert read(document, payload, "y") == [1, 2, 3]

    document, payload = capture(torch.tensor([True, False, True]))
    assert read(document, payload, "y") == [1, 0, 1]


def test_nan_statistics_survive_the_conversion():
    document, _ = capture(torch.tensor([1.0, float("nan"), 3.0, float("inf")]))
    stats = document["descriptor"]["stats"]

    assert stats["nanCount"] == 1
    assert stats["infCount"] == 1
    assert stats["max"] == 3.0


def test_sparse_tensor_is_described_rather_than_densified():
    """A sparse tensor is sparse because the dense form does not fit.

    Deciding to materialise it on the user's behalf could exhaust memory in the
    process they are debugging.
    """
    indices = torch.tensor([[0, 1], [1, 0]])
    values = torch.tensor([3.0, 4.0])
    sparse = torch.sparse_coo_tensor(indices, values, (2, 2))

    document, _ = capture(sparse)
    assert document["ok"] is True
    assert document["descriptor"]["channels"] == []
    assert "to_dense" in " ".join(document["warnings"])


def test_complex_tensor_explains_itself():
    document, _ = capture(torch.tensor([1 + 2j, 3 + 4j]))
    assert document["ok"] is True
    assert document["descriptor"]["channels"] == []
    assert document["warnings"]


def test_histogram_of_a_tensor():
    document, _ = capture(torch.arange(100, dtype=torch.float32), viz="histogram", bins=4)
    assert "binCount" in channels(document)


def test_torch_wins_over_numpy():
    from _pdv.registry import registry

    adapter = registry.resolve(torch.tensor([1.0]))
    assert adapter is not None and adapter.name == "torch.Tensor"


def test_large_tensor_is_decimated_with_honest_statistics():
    values = torch.zeros(200_000)
    values[123_456] = 999.0

    document, _ = capture(values, maxPoints=2000)

    assert document["descriptor"]["decimation"]["originalLength"] == 200_000
    assert document["descriptor"]["stats"]["max"] == 999.0
