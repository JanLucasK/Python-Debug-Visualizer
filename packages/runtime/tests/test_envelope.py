from __future__ import annotations

import string

import pytest

from _pdv import envelope

BASE64_ALPHABET = set(string.ascii_letters + string.digits + "+/=")


def test_roundtrip_document_and_payload():
    document = {"hello": "world", "n": 42}
    payload = bytes(range(256))
    decoded_doc, decoded_payload = envelope.decode(envelope.encode(document, payload))
    assert decoded_doc == document
    assert decoded_payload == payload


def test_roundtrip_without_payload():
    decoded_doc, decoded_payload = envelope.decode(envelope.encode({"a": 1}))
    assert decoded_doc == {"a": 1}
    assert decoded_payload == b""


@pytest.mark.parametrize(
    "text",
    [
        r"C:\Users\jan\data.csv",
        "quote ' and \" and \\ backslash",
        "newline \n tab \t",
        "unicode: äöü 日本語 🐍",
        r"regex ^\d+\.\d+$",
    ],
)
def test_output_is_repr_safe(text):
    """The whole point of the envelope: nothing that repr would escape.

    A DAP evaluate response is the *repr* of the returned string. If the
    encoding could emit a quote or a backslash, the extension would have to
    un-escape a Python string literal by hand -- which is where the existing
    tools in this space corrupt Windows paths and regexes.
    """
    encoded = envelope.encode({"text": text}, text.encode("utf-8"))

    assert set(encoded) <= BASE64_ALPHABET
    assert repr(encoded) == "'" + encoded + "'"

    document, payload = envelope.decode(encoded)
    assert document["text"] == text
    assert payload.decode("utf-8") == text


def test_large_payload_survives():
    payload = bytes(4_000_000)
    _, decoded = envelope.decode(envelope.encode({}, payload))
    assert decoded == payload


def test_nan_in_document_is_rejected_loudly():
    """JSON cannot represent NaN, and a silently-emitted `NaN` token would break
    the extension's parser. Statistics are sanitised upstream; this asserts the
    envelope does not paper over a miss."""
    with pytest.raises(ValueError):
        envelope.encode({"value": float("nan")})
