// ACP JSON-RPC client for an agent's native stdio protocol. The transport owns
// process lifetime; this client correlates requests and fails pending work on loss.

export type AcpMessage = Record<string, unknown>;
export type AcpSend = (line: string) => Promise<void>;
export type AcpRequestHandler = (method: string, params: unknown) => Promise<unknown>;

/** An agent's RPC error may contain untrusted or secret text; retain only its code. */
export class AcpRemoteError extends Error {
  readonly code: number | null;
  constructor(code: unknown) {
    super("ACP agent returned an error");
    this.code = typeof code === "number" && Number.isSafeInteger(code) ? code : null;
  }
}

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class AcpClient {
  private buffer = "";
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }>();
  private nextId = 0;
  private closed = false;

  constructor(
    private readonly send: AcpSend,
    private readonly onRequest: AcpRequestHandler,
    private readonly onNotification: (method: string, params: unknown) => void,
    private readonly onReplySent?: (method: string, params: unknown) => void,
  ) {}

  request(method: string, params: unknown, timeoutMs: number | null = DEFAULT_REQUEST_TIMEOUT_MS, onSent?: () => void): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("ACP connection is closed"));
    // session/prompt is the streaming lifetime of an entire agent turn, not a
    // short RPC. It ends on reply, cancellation, transport loss, or session
    // close; the outer run owns any operator-configured timeout.
    if ((timeoutMs === null && method !== "session/prompt") ||
      (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0))) {
      return Promise.reject(new Error("invalid ACP request timeout"));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === null ? null : setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      void this.write({ jsonrpc: "2.0", id, method, params }).then(
        () => onSent?.(),
        () => this.close("ACP transport write failed"),
      );
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
      if (pending.timer) clearTimeout(pending.timer);
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
          async (result) => {
            await this.write({ jsonrpc: "2.0", id, result: result ?? {} });
            this.onReplySent?.(message.method as string, message.params);
          },
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
    if (pending.timer) clearTimeout(pending.timer);
    if (message.error !== undefined) {
      const error = message.error as { code?: unknown } | null;
      pending.reject(new AcpRemoteError(error?.code));
    } else if ("result" in message) pending.resolve(message.result);
    else pending.reject(new Error("ACP response has no result"));
  }
}
