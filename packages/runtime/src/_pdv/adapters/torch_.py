"""PyTorch adapter.

A tensor is an array once three things have been dealt with: the autograd graph,
the device it lives on, and dtypes NumPy has never heard of. All three are
handled here, and then the NumPy builders do the actual work — the wire format
is identical, so a tensor and an ndarray produce the same plot.

As always, torch is taken from ``sys.modules`` and never imported. Importing
torch into a process that had not imported it can initialise CUDA and cost
seconds, which is not something a visualizer may do to a program under debug.
"""

from __future__ import annotations

import sys
from typing import Any, Dict, List

from ..codec import preview, qualified_type
from ..descriptor import Capture, Descriptor
from ..registry import Adapter, Registry
from . import numpy_


class TorchAdapter(Adapter):
    name = "torch.Tensor"

    def score(self, value: Any) -> int:
        torch = sys.modules.get("torch")
        if torch is None:
            return 0
        return 90 if isinstance(value, torch.Tensor) else 0

    def build(self, value: Any, options: Dict[str, Any]) -> Capture:
        torch = sys.modules["torch"]
        np = sys.modules.get("numpy")
        if np is None:
            from ..errors import CaptureError

            raise CaptureError(
                "NumpyMissing",
                "Reading a tensor needs numpy, which this process has not imported.",
            )

        warnings: List[str] = []

        if value.is_sparse or getattr(value, "is_sparse_csr", False):
            # Densifying is not ours to decide: a sparse tensor is sparse
            # because the dense form does not fit.
            return _describe_only(
                value,
                ["Sparse tensors are not converted. Use x.to_dense() if it fits in memory."],
            )

        array = _to_numpy(torch, np, value, warnings)
        if array is None:
            return _describe_only(
                value, warnings + ["dtype {} has no NumPy equivalent.".format(value.dtype)]
            )

        capture = numpy_.NumpyAdapter().build(array, options)
        # The value the user asked about was a tensor, so say so rather than
        # reporting the ndarray we made on the way.
        capture.descriptor.python_type = qualified_type(value)
        capture.descriptor.preview = preview(value)
        capture.descriptor.dtype = str(value.dtype).replace("torch.", "")
        capture.warnings = warnings + capture.warnings
        return capture


def _to_numpy(torch: Any, np: Any, tensor: Any, warnings: List[str]) -> Any:
    """Detach, move to host memory and widen dtypes NumPy cannot express."""
    working = tensor.detach()  # a tensor requiring grad refuses .numpy() outright

    if working.device.type != "cpu":
        # A copy, so nothing the program is using is disturbed.
        working = working.cpu()

    # bfloat16 and float16 are torch's own; NumPy has float16 but no bfloat16,
    # and neither survives into JavaScript. Widening to float32 keeps every
    # value exactly, since float32 covers both ranges without loss.
    if working.dtype in (torch.bfloat16, torch.float16):
        working = working.to(torch.float32)
    elif working.dtype in (torch.complex64, torch.complex128):
        return None

    try:
        return working.numpy()
    except (RuntimeError, TypeError):
        return None


def _describe_only(tensor: Any, warnings: List[str]) -> Capture:
    descriptor = Descriptor(
        kind="ndarray",
        python_type=qualified_type(tensor),
        preview=preview(tensor),
        shape=[int(d) for d in tensor.shape],
        dtype=str(tensor.dtype).replace("torch.", ""),
        nbytes=None,
        channels=[],
        truncated=True,
        suggested_viz=["tree"],
    )
    return Capture(descriptor=descriptor, warnings=warnings)


def install(registry: Registry) -> None:
    registry.register(TorchAdapter())
