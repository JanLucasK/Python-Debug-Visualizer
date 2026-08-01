"""A minimal Debug Adapter Protocol client.

Just enough of DAP to attach to a debugpy process, wait for it to stop, and
issue `evaluate` requests -- which is exactly what the extension does. Written
here rather than mocked because the properties under test are debugpy's own
behaviour, and a mock would only assert what we already believe.
"""

from __future__ import annotations

import json
import socket
import threading
from typing import Any, Dict, List, Optional


class DapClient:
    def __init__(self, host: str = "127.0.0.1", port: int = 5678) -> None:
        self._socket = socket.create_connection((host, port), timeout=60)
        self._buffer = b""
        self._seq = 0
        self._responses: Dict[int, Dict[str, Any]] = {}
        self._events: List[Dict[str, Any]] = []
        self._lock = threading.Condition()
        self._closed = False

        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    # -- wire framing ------------------------------------------------------ #

    def _read_loop(self) -> None:
        try:
            while True:
                message = self._read_message()
                if message is None:
                    break
                with self._lock:
                    if message.get("type") == "response":
                        self._responses[message["request_seq"]] = message
                    elif message.get("type") == "event":
                        self._events.append(message)
                    self._lock.notify_all()
        except OSError:
            pass
        finally:
            with self._lock:
                self._closed = True
                self._lock.notify_all()

    def _read_message(self) -> Optional[Dict[str, Any]]:
        while b"\r\n\r\n" not in self._buffer:
            chunk = self._socket.recv(65536)
            if not chunk:
                return None
            self._buffer += chunk

        header, _, rest = self._buffer.partition(b"\r\n\r\n")
        length = next(
            int(line.split(b":")[1])
            for line in header.split(b"\r\n")
            if line.lower().startswith(b"content-length")
        )
        while len(rest) < length:
            chunk = self._socket.recv(65536)
            if not chunk:
                return None
            rest += chunk

        self._buffer = rest[length:]
        return json.loads(rest[:length].decode("utf-8"))

    def _send(self, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self._socket.sendall(b"Content-Length: %d\r\n\r\n%s" % (len(body), body))

    # -- protocol ---------------------------------------------------------- #

    def send_request(self, command: str, arguments: Optional[Dict[str, Any]] = None) -> int:
        """Send a request and return its sequence number without waiting.

        Needed because `launch` does not complete until after the client has
        answered the `initialized` event with `configurationDone` — waiting for
        its response inline would deadlock against the adapter.
        """
        self._seq += 1
        self._send(
            {
                "seq": self._seq,
                "type": "request",
                "command": command,
                "arguments": arguments or {},
            }
        )
        return self._seq

    def await_response(self, seq: int, timeout: float = 60) -> Dict[str, Any]:
        with self._lock:
            if not self._lock.wait_for(
                lambda: seq in self._responses or self._closed, timeout=timeout
            ):
                raise TimeoutError("no response to request {}".format(seq))
            if seq not in self._responses:
                raise ConnectionError("adapter closed while waiting for request {}".format(seq))
            return self._responses.pop(seq)

    def request(
        self, command: str, arguments: Optional[Dict[str, Any]] = None, timeout: float = 60
    ) -> Dict[str, Any]:
        return self.await_response(self.send_request(command, arguments), timeout=timeout)

    def wait_for_event(self, event: str, timeout: float = 60) -> Dict[str, Any]:
        """Consume the oldest matching event, waiting for one if necessary.

        Events are buffered by the reader thread, so an event that arrived
        before this call is still found -- which matters because `initialized`
        routinely overtakes the `attach` response.
        """
        with self._lock:
            arrived = self._lock.wait_for(
                lambda: self._closed or any(c.get("event") == event for c in self._events),
                timeout=timeout,
            )
            if not arrived:
                raise TimeoutError("event {!r} never arrived".format(event))
            for index, candidate in enumerate(self._events):
                if candidate.get("event") == event:
                    return self._events.pop(index)
            raise ConnectionError("adapter closed while waiting for {!r}".format(event))

    def launch_and_wait_for_stop(self, program: str, python: str) -> int:
        """Run the full VS Code handshake and return the frame id it stopped in."""
        self.request("initialize", {"adapterID": "pdv-test", "linesStartAt1": True, "pathFormat": "path"})

        launch = self.send_request(
            "launch",
            {
                "request": "launch",
                "type": "debugpy",
                "name": "pdv-test",
                "program": program,
                "python": python,
                "console": "internalConsole",
                "justMyCode": False,
            },
        )

        self.wait_for_event("initialized")
        self.request("configurationDone")

        response = self.await_response(launch, timeout=120)
        if not response["success"]:
            raise RuntimeError("launch failed: {}".format(response.get("message")))

        stopped = self.wait_for_event("stopped", timeout=120)
        frames = self.request("stackTrace", {"threadId": stopped["body"]["threadId"], "levels": 1})
        return frames["body"]["stackFrames"][0]["id"]

    def evaluate(
        self,
        expression: str,
        frame_id: int,
        context: str = "clipboard",
        raw_string: bool = True,
    ) -> Dict[str, Any]:
        arguments: Dict[str, Any] = {
            "expression": expression,
            "frameId": frame_id,
            "context": context,
        }
        if raw_string:
            arguments["format"] = {"rawString": True}
        return self.request("evaluate", arguments)

    def close(self) -> None:
        try:
            self._socket.close()
        except OSError:
            pass
