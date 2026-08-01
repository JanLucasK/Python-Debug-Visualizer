"""TensorFlow adapter.

Shorter than the torch one because eager tensors already carry their values and
convert with a single call. The case worth handling explicitly is the *symbolic*
tensor: inside a traced ``tf.function`` a tensor is a node in a graph and has no
value at all, so there is nothing to plot and saying why is the only useful
answer.
"""

from __future__ import annotations

import sys
from typing import Any, Dict, List

from ..codec import preview, qualified_type
from ..descriptor import Capture, Descriptor
from ..registry import Adapter, Registry
from . import numpy_


class TensorFlowAdapter(Adapter):
    name = "tensorflow.Tensor"

    def score(self, value: Any) -> int:
        tf = sys.modules.get("tensorflow")
        if tf is None:
            return 0
        if isinstance(value, tf.Tensor) or isinstance(value, getattr(tf, "Variable", ())):
            return 90
        return 0

    def build(self, value: Any, options: Dict[str, Any]) -> Capture:
        np = sys.modules.get("numpy")
        if np is None:
            from ..errors import CaptureError

            raise CaptureError(
                "NumpyMissing",
                "Reading a tensor needs numpy, which this process has not imported.",
            )

        to_numpy = getattr(value, "numpy", None)
        if to_numpy is None:
            return _describe_only(
                value,
                [
                    "This is a symbolic tensor with no value yet — it is a node in a graph, "
                    "not data. Inspect it outside tf.function, or use tf.print."
                ],
            )

        try:
            array = to_numpy()
        except Exception as exc:  # NotImplementedError inside a traced function
            return _describe_only(value, ["Could not read the tensor: {}".format(exc)])

        capture = numpy_.NumpyAdapter().build(np.asarray(array), options)
        capture.descriptor.python_type = qualified_type(value)
        capture.descriptor.preview = preview(value)
        return capture


def _describe_only(tensor: Any, warnings: List[str]) -> Capture:
    shape = getattr(tensor, "shape", None)
    dimensions = None
    if shape is not None:
        try:
            dimensions = [int(d) for d in shape if d is not None]
        except TypeError:
            dimensions = None

    descriptor = Descriptor(
        kind="ndarray",
        python_type=qualified_type(tensor),
        preview=preview(tensor),
        shape=dimensions,
        dtype=str(getattr(tensor, "dtype", "")) or None,
        channels=[],
        truncated=True,
        suggested_viz=["tree"],
    )
    return Capture(descriptor=descriptor, warnings=warnings)


def install(registry: Registry) -> None:
    registry.register(TensorFlowAdapter())
