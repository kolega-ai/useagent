// ACP session control for a single native agent process. The owner supplies a
// sandbox transport and handles approvals; it must bind this session to the
// persisted provider authority before a prompt is sent.
import type { AcpMessage } from "./acp-client";
import { AcpClient } from "./acp-client";

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export interface AcpPermission {
  readonly sessionId: string;
  readonly toolCall: unknown;
  readonly options: readonly { readonly optionId: string; readonly kind: string; readonly name: string }[];
}

export class AcpSessionControl {
  private sessionId: string | null = null;
  private loading = false;
  private opening = false;
  private earlyUpdates: Array<{ sessionId: string; update: AcpMessage }> = [];
  private earlyBytes = 0;
  private readonly client: AcpClient;
  private readonly permissionRequests = new WeakMap<object, AcpPermission>();

  constructor(
    send: (line: string) => Promise<void>,
    private readonly permission: (request: AcpPermission) => Promise<string | null>,
    private readonly update: (sessionId: string, update: AcpMessage) => void,
    private readonly permissionSent?: (request: AcpPermission) => void,
  ) {
    this.client = new AcpClient(send, (method, params) => this.incomingRequest(method, params), (method, params) => this.notification(method, params), (method, params) => {
      if (method !== "session/request_permission" || !params || typeof params !== "object") return;
      const request = this.permissionRequests.get(params);
      if (request) this.permissionSent?.(request);
      this.permissionRequests.delete(params);
    });
  }

  ingest(bytes: Uint8Array): void { this.client.ingest(bytes); }
  close(reason?: string): void { this.client.close(reason); }

  async open(cwd: string, resumeId?: string): Promise<string> {
    if (this.sessionId !== null) throw new Error("ACP session is already open");
    const initialized = object(await this.client.request("initialize", { protocolVersion: 1, clientCapabilities: {} }));
    if (initialized?.protocolVersion !== 1) throw new Error("ACP protocol version is unsupported");
    if (resumeId) {
      if (object(initialized.agentCapabilities)?.loadSession !== true) throw new Error("ACP agent cannot restore sessions");
      // Kolega Code's load handler does not enforce cwd and returns `{}` for
      // missing IDs. Its session/list applies the cwd filter before load.
      const listing = object(await this.client.request("session/list", { cwd }));
      if (!Array.isArray(listing?.sessions) || !listing.sessions.some((entry) => object(entry)?.sessionId === resumeId)) {
        throw new Error("ACP session could not be restored in this workspace");
      }
      this.loading = true;
      try {
        const result = await this.client.request("session/load", { sessionId: resumeId, cwd, mcpServers: [] });
        // This native agent returns `{}` for an unknown ID. A real load carries
        // its model, mode, and permission config; a bare success is not proof.
        const options = object(result)?.configOptions;
        if (!Array.isArray(options) || !options.some((entry) => object(entry)?.id === "mode") ||
          !options.some((entry) => object(entry)?.id === "permission-auto")) {
          throw new Error("ACP session could not be restored");
        }
        this.sessionId = resumeId;
      } finally { this.loading = false; }
    } else {
      this.opening = true;
      try {
        const result = object(await this.client.request("session/new", { cwd, mcpServers: [] }));
        if (typeof result?.sessionId !== "string" || !result.sessionId) throw new Error("ACP agent did not return a session id");
        this.sessionId = result.sessionId;
        for (const pending of this.earlyUpdates) {
          if (pending.sessionId === this.sessionId) this.update(this.sessionId, pending.update);
        }
      } finally {
        this.opening = false;
        this.earlyUpdates = [];
        this.earlyBytes = 0;
      }
    }
    return this.sessionId;
  }

  async configure(configId: string, value: string | boolean): Promise<void> {
    const sessionId = this.requireSession();
    const result = object(await this.client.request("session/set_config_option", { sessionId, configId, value }));
    const options = result?.configOptions;
    const selected = Array.isArray(options) ? options.map(object).find((option) => option?.id === configId) : null;
    if (!selected || selected.currentValue !== value) throw new Error("ACP agent did not confirm the requested session configuration");
  }

  async prompt(text: string, timeoutMs: number, onSent?: () => void): Promise<string> {
    const sessionId = this.requireSession();
    const result = object(await this.client.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, timeoutMs, onSent));
    if (typeof result?.stopReason !== "string") throw new Error("ACP prompt ended without a stop reason");
    return result.stopReason;
  }

  async cancel(): Promise<void> {
    await this.client.notify("session/cancel", { sessionId: this.requireSession() });
  }

  private requireSession(): string {
    if (!this.sessionId) throw new Error("ACP session is not open");
    return this.sessionId;
  }

  private async incomingRequest(method: string, params: unknown): Promise<unknown> {
    const input = object(params);
    if (method !== "session/request_permission" || !input || input.sessionId !== this.sessionId || !Array.isArray(input.options)) {
      throw new Error("unsupported ACP client request");
    }
    const options = input.options.flatMap((value) => {
      const option = object(value);
      if (typeof option?.optionId !== "string" || typeof option.kind !== "string" || typeof option.name !== "string") return [];
      return [{ optionId: option.optionId, kind: option.kind, name: option.name }];
    });
    const request = { sessionId: this.requireSession(), toolCall: input.toolCall, options };
    this.permissionRequests.set(input, request);
    const selected = await this.permission(request);
    if (!selected || !options.some((option) => option.optionId === selected)) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId: selected } };
  }

  private notification(method: string, params: unknown): void {
    const input = object(params);
    const update = object(input?.update);
    // session/load replays history: the durable product log already has it.
    if (this.loading || method !== "session/update" || !update || typeof input?.sessionId !== "string") return;
    if (this.opening && !this.sessionId) {
      this.earlyBytes += Buffer.byteLength(JSON.stringify(update));
      if (this.earlyUpdates.length >= 100 || this.earlyBytes > 1024 * 1024) {
        this.client.close("ACP startup updates exceeded the limit");
        return;
      }
      this.earlyUpdates.push({ sessionId: input.sessionId, update });
      return;
    }
    if (input.sessionId === this.sessionId) this.update(input.sessionId, update);
  }
}
