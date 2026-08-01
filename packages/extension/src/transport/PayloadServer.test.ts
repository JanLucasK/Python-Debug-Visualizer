import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { PayloadServer } from "./PayloadServer";

const runtimeSrc = resolve(__dirname, "..", "..", "..", "runtime", "src");
const venvPython = resolve(__dirname, "..", "..", "..", "..", ".venv", "bin", "python");
const python = existsSync(venvPython) ? venvPython : "python3";
const run = promisify(execFile);

/**
 * Runs the real Python transport against the real listener.
 *
 * Both halves of this framing were written from the same description, and a
 * description is not a guarantee -- a wrong offset or endianness would produce
 * plausible-looking numbers rather than an error. Nothing but running them
 * against each other proves they agree.
 *
 * Asynchronous, and that is not a style preference. The sender blocks until the
 * listener acknowledges receipt, so spawning it synchronously would block the
 * event loop that has to do the acknowledging: a deadlock until one side times
 * out.
 */
function sendFromPython(script: string): Promise<unknown> {
  return run(python, ["-c", script], {
    env: { ...process.env, PYTHONPATH: runtimeSrc },
    timeout: 60_000,
  });
}

const servers: PayloadServer[] = [];

function server(): PayloadServer {
  const created = new PayloadServer();
  servers.push(created);
  return created;
}

afterEach(() => {
  for (const created of servers.splice(0)) created.dispose();
});

describe("PayloadServer", () => {
  it("receives a payload the Python transport sent over the socket", async () => {
    const listener = server();
    const port = await listener.ensureListening();
    const { token, bytes } = listener.expect(0, 30_000);

    const sent = sendFromPython(`
from _pdv import transport
payload = bytes(range(256)) * 400
descriptor, inline = transport.deliver(payload, {"transport": {"port": ${port}, "token": "${token}", "threshold": 1}})
assert descriptor["encoding"] == "socket", descriptor
assert inline == b""
`);

    const [received] = await Promise.all([bytes, sent]);
    expect(received.length).toBe(256 * 400);
    expect(received[0]).toBe(0);
    expect(received[255]).toBe(255);
  });

  it("carries several megabytes intact", async () => {
    // The size that motivates the side channel in the first place.
    const listener = server();
    const port = await listener.ensureListening();
    const { token, bytes } = listener.expect(0, 30_000);

    const sent = sendFromPython(`
import hashlib
from _pdv import transport
payload = bytes(range(256)) * 20000  # ~5 MB
transport.deliver(payload, {"transport": {"port": ${port}, "token": "${token}", "threshold": 1}})
print(hashlib.sha256(payload).hexdigest())
`);

    const [received] = await Promise.all([bytes, sent]);
    expect(received.length).toBe(256 * 20000);
    // Spot-check the tail: a length or offset mistake shows up at the end.
    expect(received[received.length - 1]).toBe(255);
  });

  it("keeps payloads apart when two are in flight", async () => {
    const listener = server();
    const port = await listener.ensureListening();
    const first = listener.expect(0, 30_000);
    const second = listener.expect(0, 30_000);

    const sent = sendFromPython(`
from _pdv import transport
settings = {"port": ${port}, "threshold": 1}
transport.deliver(b"AAAA" * 100, {"transport": {**settings, "token": "${second.token}"}})
transport.deliver(b"BBBB" * 100, {"transport": {**settings, "token": "${first.token}"}})
`);

    await sent;
    // Delivered in the opposite order to the reservations, so a queue rather
    // than a token lookup would hand each one the other's bytes.
    expect(new TextDecoder().decode(await first.bytes)).toBe("BBBB".repeat(100));
    expect(new TextDecoder().decode(await second.bytes)).toBe("AAAA".repeat(100));
  });

  it("rejects a payload whose token it never issued", async () => {
    const listener = server();
    const port = await listener.ensureListening();
    const { bytes } = listener.expect(0, 500);

    await sendFromPython(`
from _pdv import transport
transport.deliver(b"x" * 100, {"transport": {"port": ${port}, "token": "not-a-real-token", "threshold": 1}})
`);

    // The waiting reservation must not be handed someone else's bytes.
    await expect(bytes).rejects.toThrow(/did not deliver/);
  });

  it("times out rather than waiting forever", async () => {
    const listener = server();
    await listener.ensureListening();
    const { bytes } = listener.expect(1024, 100);

    await expect(bytes).rejects.toThrow(/within 100 ms/);
  });

  it("falls back to a file when nothing is listening", () => {
    // The container-sharing-a-volume case, and the general safety net: a
    // failed socket must not become a failed capture.
    const output = execFileSync(
      python,
      [
        "-c",
        `
from _pdv import transport
descriptor, inline = transport.deliver(b"payload" * 1000, {"transport": {"port": 1, "token": "t", "threshold": 1}})
assert descriptor["encoding"] == "file", descriptor
print(descriptor["path"])
`,
      ],
      { env: { ...process.env, PYTHONPATH: runtimeSrc }, encoding: "utf8" },
    ).trim();

    expect(readFileSync(output)).toEqual(Buffer.from("payload".repeat(1000)));
    unlinkSync(output);
  });

  it("stays inline below the threshold", () => {
    const output = execFileSync(
      python,
      [
        "-c",
        `
from _pdv import transport
descriptor, inline = transport.deliver(b"small", {"transport": {"port": 1, "token": "t"}})
print(descriptor["encoding"], len(inline))
`,
      ],
      { env: { ...process.env, PYTHONPATH: runtimeSrc }, encoding: "utf8" },
    ).trim();

    expect(output).toBe("inline 5");
  });

  it("binds to loopback only", async () => {
    // This listener accepts raw bytes from anything that can reach it, so it
    // must not be reachable from the network.
    const listener = server();
    await listener.ensureListening();

    const address = (
      listener as unknown as { server: { address(): { address: string } } }
    ).server.address();
    expect(address.address).toBe("127.0.0.1");
  });
});
