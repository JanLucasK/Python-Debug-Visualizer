import { randomBytes } from "node:crypto";
import { type Server, type Socket, createServer } from "node:net";
import { log } from "../log";

/**
 * Loopback listener the debuggee sends large payloads to.
 *
 * It runs in the extension host, which under Remote-SSH and in dev containers
 * is the *same machine* as the debuggee — that is what makes a plain loopback
 * socket the right channel rather than something tunnelled. It is also why the
 * webview never opens one: the webview runs locally, where `127.0.0.1` means a
 * different computer entirely.
 *
 * Bound to loopback and gated on a single-use token, so nothing else on the
 * machine can push bytes in or read what is queued.
 */
export class PayloadServer {
  private server: Server | undefined;
  private port = 0;
  private readonly pending = new Map<string, PendingPayload>();

  /** Port to hand to the debuggee, starting the listener if needed. */
  async ensureListening(): Promise<number> {
    if (this.server) return this.port;

    this.server = createServer((socket) => this.receive(socket));
    this.server.on("error", (error) => log.error(`Payload listener failed: ${error.message}`));

    await new Promise<void>((resolve, reject) => {
      // Port 0: the operating system picks a free one, so two windows never
      // collide. Loopback only -- this must not be reachable from the network.
      this.server?.listen({ host: "127.0.0.1", port: 0 }, resolve);
      this.server?.once("error", reject);
    });

    const address = this.server.address();
    this.port = typeof address === "object" && address ? address.port : 0;
    log.info(`Payload listener on 127.0.0.1:${this.port}`);
    return this.port;
  }

  /**
   * Reserve a token and wait for its bytes.
   *
   * The reservation happens *before* the capture is evaluated, because the
   * debuggee may connect and finish sending while the evaluate response is
   * still on its way back. Registering afterwards would lose that race
   * intermittently, which is the worst way for it to fail.
   */
  expect(byteLength: number, timeoutMs: number): { token: string; bytes: Promise<Uint8Array> } {
    const token = randomBytes(16).toString("hex");

    const bytes = new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(token);
        reject(
          new Error(`The debuggee did not deliver ${byteLength} bytes within ${timeoutMs} ms.`),
        );
      }, timeoutMs);
      // Node keeps the process alive for pending timers; this one must not.
      timer.unref?.();

      this.pending.set(token, { resolve, reject, timer });
    });

    return { token, bytes };
  }

  /** Give up on a reservation whose capture failed before it could be used. */
  cancel(token: string): void {
    const waiting = this.pending.get(token);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    this.pending.delete(token);
    waiting.reject(new Error("Capture abandoned."));
  }

  private receive(socket: Socket): void {
    const chunks: Buffer[] = [];
    let received = 0;

    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      received += chunk.length;
    });

    socket.on("error", () => socket.destroy());

    socket.on("end", () => {
      const message = Buffer.concat(chunks, received);
      // Frame: token line, 8-byte little-endian length, payload.
      const newline = message.indexOf(0x0a);
      if (newline < 0 || message.length < newline + 1 + 8) {
        log.warn("Discarded a malformed payload frame.");
        socket.end();
        return;
      }

      const token = message.subarray(0, newline).toString("ascii");
      const declared = Number(message.readBigUInt64LE(newline + 1));
      const payload = message.subarray(newline + 9);

      const waiting = this.pending.get(token);
      if (!waiting) {
        // An unknown token means a stale or forged connection, and its bytes
        // must not be handed to whoever is waiting next.
        log.warn("Discarded a payload with an unrecognised token.");
        socket.end();
        return;
      }

      this.pending.delete(token);
      clearTimeout(waiting.timer);

      if (payload.length !== declared) {
        waiting.reject(new Error(`Payload was ${payload.length} bytes but announced ${declared}.`));
      } else {
        const copy = new Uint8Array(payload.length);
        copy.set(payload);
        waiting.resolve(copy);
      }
      // Closing is the debuggee's signal that the bytes landed; it blocks until
      // then so a discarded socket cannot lose buffered data.
      socket.end();
    });
  }

  dispose(): void {
    for (const [token, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error("Extension shutting down."));
      this.pending.delete(token);
    }
    this.server?.close();
    this.server = undefined;
  }
}

interface PendingPayload {
  resolve(bytes: Uint8Array): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}
