// Sandbox process transport for the ACP protocol. Kolega Code exposes ACP over
// stdio; session state remains in the attached sandbox and is loaded by id.
import type { SandboxHandle } from "../sandboxes/provider";
import type { ExpectedSandboxBinding } from "../sandboxes/expected-binding";
import { AGENT_SOURCE_CONTROL_ENV } from "../repositories/agent-credentials";
import { AcpSessionControl, type AcpPermission } from "./acp-session";
import { AcpRemoteError } from "./acp-client";
import {
  acpProcessSessionPrefix,
  cleanupOwnedAcpTransports,
  processSessionTransportAvailable,
  ProcessSessionPiRpcTransport,
} from "./pi-rpc-transport";

export interface AcpRuntime {
  readonly executable: string;
  readonly home: string;
  readonly model: string;
  readonly style: "openai_responses" | "openai_chat" | "anthropic";
  readonly mode: "plan" | "build";
  readonly permission: "ask" | "auto";
  readonly runAsUser: string | null;
  readonly spoolDirectory: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function acpLaunchCommand(runtime: AcpRuntime, sourceControlEnv = AGENT_SOURCE_CONTROL_ENV): string {
  const env: Record<string, string> = {
    HOME: runtime.home,
    PATH: "/usr/local/bin:/usr/bin:/bin",
    PYTHONUNBUFFERED: "1",
    KOLEGA_CODE_PROVIDER: "custom:cli",
    KOLEGA_CODE_MODEL: runtime.model,
    KOLEGA_CODE_ENDPOINT_URL: "http://127.0.0.1:19483/provider",
    KOLEGA_CODE_ENDPOINT_STYLE: runtime.style,
    KOLEGA_CODE_ENDPOINT_API_KEY: "useagent-broker",
    KOLEGA_CODE_ENDPOINT_CONTEXT: "1048576",
    KOLEGA_CODE_ENDPOINT_MAX_OUTPUT: "65536",
    ...(runtime.style === "openai_responses" ? { KOLEGA_CODE_ENDPOINT_THINKING: "openai_responses_reasoning" } : {}),
  };
  const launch = `[ ! -r ${shellQuote(sourceControlEnv)} ] || . ${shellQuote(sourceControlEnv)}; ` +
    `exec ${shellQuote(runtime.executable)} acp --permission-mode ${runtime.permission}`;
  const command = `exec env -i ${Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ")} /bin/sh -c ${shellQuote(launch)}`;
  return runtime.runAsUser
    ? `exec su -s /bin/sh ${shellQuote(runtime.runAsUser)} -c ${shellQuote(command)}`
    : command;
}

/** Reapply the current turn's choices after both creation and session load. */
export async function configureAcpSession(
  control: Pick<AcpSessionControl, "configure">,
  runtime: Pick<AcpRuntime, "permission" | "mode">,
): Promise<void> {
  await control.configure("mode", runtime.mode);
  await control.configure("permission-auto", runtime.permission);
}

/** Give useful, bounded diagnostics without exposing native process output. */
export function acpPromptFailure(error: unknown): string {
  if (error instanceof AcpRemoteError) {
    const code = error.code === null ? "" : ` (code ${error.code})`;
    return `Kolega Code returned an agent protocol error${code}. Check the agent session and retry.`;
  }
  const reason = error instanceof Error ? error.message : "";
  switch (reason) {
    case "ACP sandbox process exited":
      return "Kolega Code stopped inside the sandbox before completing. Check the sandbox and retry.";
    case "ACP sandbox transport disconnected":
    case "ACP transport disconnected":
      return "Kolega Code lost its connection to the sandbox. Check the sandbox and retry.";
    case "ACP transport write failed":
      return "UseAgent could not send a request to Kolega Code in the sandbox. Check the sandbox and retry.";
    case "ACP protocol frame is invalid":
    case "ACP response has no result":
    case "ACP prompt ended without a stop reason":
      return "Kolega Code returned an invalid protocol response. Check the agent version and retry.";
    default:
      return "Kolega Code could not complete its session. Check the agent and sandbox, then retry.";
  }
}

export class SandboxAcpSession {
  readonly sessionFile: string;
  readonly sandboxId: string;
  readonly expectedSandbox?: ExpectedSandboxBinding;
  private readonly listeners = new Set<(event: unknown) => void>();
  private pendingPermission: ((request: AcpPermission) => Promise<string | null>) | null = null;
  private permissionSent: ((request: AcpPermission) => void) | null = null;
  private active = false;
  private closed = false;

  private constructor(
    private readonly control: AcpSessionControl,
    private readonly transport: ProcessSessionPiRpcTransport,
    sessionId: string,
    sandboxId: string,
    expectedSandbox?: ExpectedSandboxBinding,
  ) {
    this.sessionFile = sessionId;
    this.sandboxId = sandboxId;
    this.expectedSandbox = expectedSandbox;
  }

  static async open(input: {
    readonly sandbox: SandboxHandle;
    readonly workdir: string;
    readonly runtime: AcpRuntime;
    readonly resumeId?: string;
    readonly expectedSandbox?: ExpectedSandboxBinding;
  }): Promise<SandboxAcpSession> {
    if (!processSessionTransportAvailable(input.sandbox.process)) {
      throw new Error("This sandbox does not support the process-session transport required by Kolega Code");
    }
    await cleanupOwnedAcpTransports(input.sandbox, { spoolDirectory: input.runtime.spoolDirectory });
    let control: AcpSessionControl;
    let instance: SandboxAcpSession | undefined;
    const transport = new ProcessSessionPiRpcTransport(
      input.sandbox.process,
      `${acpProcessSessionPrefix(input.sandbox.id)}${crypto.randomUUID()}`,
      acpLaunchCommand(input.runtime),
      (data) => control.ingest(data),
      input.runtime.spoolDirectory,
      true,
    );
    control = new AcpSessionControl(
      (line) => transport.sendInput(line),
      (request) => instance?.pendingPermission?.(request) ?? Promise.resolve(null),
      (_id, update) => instance?.emit(update),
      (request) => instance?.permissionSent?.(request),
    );
    try {
      await transport.start();
      void transport.waitForTermination().then((result) => control.close(
        result.error ? "ACP sandbox transport disconnected" : "ACP sandbox process exited",
      ));
      const sessionId = await control.open(input.workdir, input.resumeId);
      await configureAcpSession(control, input.runtime);
      instance = new SandboxAcpSession(control, transport, sessionId, input.sandbox.id, input.expectedSandbox);
      return instance;
    } catch (error) {
      control.close();
      await transport.teardown().catch(() => {});
      throw error;
    }
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onPermission(handler: (request: AcpPermission) => Promise<string | null>, sent: (request: AcpPermission) => void): void {
    this.pendingPermission = handler;
    this.permissionSent = sent;
  }

  async prompt(text: string): Promise<void> {
    if (this.closed || this.active) throw new Error("ACP session is unavailable or already running");
    this.active = true;
    this.emit({ kind: "turn.started" });
    const delivered = Promise.withResolvers<void>();
    void this.control.prompt(text, null, delivered.resolve).then(
      (reason) => this.emit(reason === "end_turn" ? { kind: "turn.completed" } : { kind: "turn.failed", error: `Kolega Code stopped: ${reason}` }),
      (error) => {
        delivered.reject(error);
        this.emit({ kind: "turn.failed", error: acpPromptFailure(error) });
      },
    ).finally(() => { this.active = false; });
    await delivered.promise;
  }

  async cancel(): Promise<void> { await this.control.cancel(); }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.control.close();
    await this.transport.teardown();
    this.listeners.clear();
  }

  private emit(event: unknown): void {
    for (const listener of this.listeners) listener(event);
  }
}
