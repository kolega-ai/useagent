// ACP JSON-RPC client for an agent's native stdio protocol. The transport owns
// process lifetime; this client correlates requests and fails pending work on loss.

export type AcpMessage = Record<string, unknown>;
export type AcpSend = (line: string) => Promise<void>;
export type AcpRequestHandler = (method: string, params: unknown) => Promise<unknown>;

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class AcpClient {
  private buffer = "";
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private nextId = 0;
  private closed = false;

  constructor(
    private readonly send: AcpSend,
    private readonly onRequest: AcpRequestHandler,
    private readonly onNotification: (method: string, params: unknown) => void,
  ) {}

  request(method: string, params: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("ACP connection is closed"));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error("invalid ACP request timeout"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      void this.write({ jsonrpc: "2.0", id, method, params }).catch(() => {
        this.close("ACP transport write failed");
      });
    });
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (this.closed) throw new Error("ACP connection is closed");
    await this.write({ jsonrpc: "2.0", method, params });
  }

  /** Accept bytes from the transport; malformed frames close the connection. */
  ingest(bytes: Uint8Array): void {
    if (this.closed) return;
    try {
      this.buffer += this.decoder.decode(bytes, { stream: true });
      let end: number;
      while ((end = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error("ACP frame too large");
        if (line.trim()) this.dispatch(JSON.parse(line));
      }
      if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES) throw new Error("ACP frame too large");
    } catch {
      this.close("ACP protocol frame is invalid");
    }
  }

  close(reason = "ACP transport disconnected"): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
    this.buffer = "";
  }

  private async write(message: AcpMessage): Promise<void> {
    if (this.closed) throw new Error("ACP connection is closed");
    await this.send(`${JSON.stringify(message)}\n`);
  }

  private dispatch(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid frame");
    const message = value as AcpMessage;
    if (message.jsonrpc !== "2.0") throw new Error("invalid protocol version");
    if (typeof message.method === "string") {
      if (typeof message.id === "string" || typeof message.id === "number") {
        const id = message.id;
        void this.onRequest(message.method, message.params).then(
          (result) => this.write({ jsonrpc: "2.0", id, result: result ?? {} }),
          () => this.write({ jsonrpc: "2.0", id, error: { code: -32603, message: "Request could not be handled" } }),
        ).catch(() => this.close("ACP transport write failed"));
      } else {
        this.onNotification(message.method, message.params);
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error !== undefined) {
      const error = message.error as { code?: unknown; message?: unknown } | null;
      const detail = typeof error?.message === "string" ? error.message.slice(0, 400) : "request failed";
      pending.reject(new Error(`ACP error: ${detail}`));
    } else if ("result" in message) pending.resolve(message.result);
    else pending.reject(new Error("ACP response has no result"));
  }
}
