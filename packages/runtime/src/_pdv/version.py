"""Version constants.

`PROTOCOL_VERSION` must stay in lockstep with `PROTOCOL_VERSION` in
``packages/protocol/src/descriptor.ts``. The extension refuses a capture whose
protocol version it does not understand rather than guessing, because a
half-understood descriptor is worse than no plot at all.
"""

from __future__ import annotations

RUNTIME_VERSION = "0.0.1"
PROTOCOL_VERSION = 1
