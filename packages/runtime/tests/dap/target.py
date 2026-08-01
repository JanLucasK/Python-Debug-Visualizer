"""Debuggee for the DAP integration test.

Creates values of the sizes that matter and then stops, so the test can evaluate
expressions against a real paused frame.
"""

import debugpy
import numpy as np

# Roughly 8 MB of float64 -- comfortably past debugpy's 64 KiB truncation limit
# once encoded, which is the point of the exercise.
large = np.sin(np.linspace(0, 500, 1_000_000))
small = np.array([1.0, 2.0, 3.0])
with_gaps = np.arange(100_000, dtype=np.float64)
with_gaps[40_000:40_500] = np.nan
windows_path = r"C:\Users\jan\re\.\d+"

debugpy.breakpoint()

print("resumed", large.size, small.size, with_gaps.size, len(windows_path))
