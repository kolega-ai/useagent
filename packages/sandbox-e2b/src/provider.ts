// E2B protocol adapter: process, filesystem and sandbox lifecycle over the E2B SDK.
import { createHash } from "node:crypto";
import {
  ConnectionConfig,
  Sandbox as SdkSandbox,
  SandboxNotFoundError as SdkSandboxNotFoundError,
  type SandboxInfo,
  type SandboxOpts,
} from "e2b";
import { SandboxNotFoundError } from "@useagent/sandbox-contract";
import { E2BSdkProcess, E2BSdkFileSystem } from "@useagent/sandbox-e2b-transport";
import type {
  SandboxCreateOptions, SandboxFileSystem, SandboxHandle,
  SandboxPreviewLink, SandboxProcess, SandboxProvider,
} from "@useagent/sandbox-contract";

const EXEC_USER = "root";

type Connection = { apiKey: string; requestTimeoutMs: number; apiUrl: string; domain: string; debug: false };

/** SDK fallbacks must not redirect a retained sandbox or introduce a second credential. */
function assertConnection(connection: Connection): void {
  const effective = new ConnectionConfig(connection);
  if (effective.apiKey !== connection.apiKey || effective.apiUrl !== connection.apiUrl ||
      effective.domain !== connection.domain || effective.debug || effective.accessToken || effective.sandboxUrl) {
    throw new Error("E2B Cloud connection changed or has an unsupported SDK override");
  }
}

function lifetimeMinutes(value?: number): number {
  return Number.isFinite(value) && value! > 0 ? value! : 30;
}

class CloudHandle implements SandboxHandle {
  readonly providerKind = "e2b" as const;
  readonly id: string;
  readonly cpu: number;
  readonly memory: number;
  readonly labels: Record<string, string>;
  readonly process: SandboxProcess;
  readonly fs: SandboxFileSystem;
  state: string;
  private instance: SdkSandbox | null;

  constructor(info: SandboxInfo, private readonly connection: Connection, instance: SdkSandbox | null, private readonly minutes: number) {
    this.id = info.sandboxId;
    this.cpu = info.cpuCount;
    this.memory = info.memoryMB / 1024;
    this.labels = info.metadata;
    this.state = info.state === "running" ? "started" : info.state;
    this.instance = instance;
    this.process = new E2BSdkProcess(() => this.connected(), { user: EXEC_USER, sessionRoot: "/tmp/useagent-e2b-sessions" });
    this.fs = new E2BSdkFileSystem(() => this.connected(), EXEC_USER);
  }

  private async connected(): Promise<SdkSandbox> {
    assertConnection(this.connection);
    if (!this.instance) {
      this.instance = await SdkSandbox.connect(this.id, { ...this.connection, timeoutMs: this.minutes * 60_000 });
      this.state = "started";
    }
    return this.instance;
  }

  async start(): Promise<void> { await this.connected(); }
  async keepAlive(): Promise<void> { await (await this.connected()).setTimeout(this.minutes * 60_000); }
  async delete(): Promise<void> {
    assertConnection(this.connection);
    await SdkSandbox.kill(this.id, this.connection);
    this.instance = null;
    this.state = "deleted";
  }
  async getPreviewLink(port: number): Promise<SandboxPreviewLink> {
    const sandbox = await this.connected();
    const token = sandbox.trafficAccessToken;
    return { url: `https://${sandbox.getHost(port)}`, ...(token ? { token, headers: { "e2b-traffic-access-token": token } } : {}) };
  }
}

export interface E2BProviderOptions {
  readonly apiKey: string;
  readonly template: string;
  readonly identityPreflightCommand: string;
  readonly timeoutMs?: number;
}

export function e2bSandboxProvider(options: E2BProviderOptions): SandboxProvider {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("E2B_API_KEY is required for E2B Cloud");
  const connection: Connection = { apiKey, requestTimeoutMs: options.timeoutMs ?? 30_000,
    apiUrl: "https://api.e2b.app", domain: "e2b.app", debug: false };
  assertConnection(connection);
  const connectionFingerprint = createHash("sha256").update(JSON.stringify(["e2b", apiKey])).digest("hex");
  async function check(handle: CloudHandle): Promise<void> {
    const result = await handle.process.executeCommand(options.identityPreflightCommand, undefined, undefined, 30);
    if (result.exitCode !== 0) throw new Error("E2B sandbox has an incompatible runtime; install the UseAgent native runtime in the selected template");
  }
  return {
    connectionFingerprint,
    async create(input: SandboxCreateOptions = {}): Promise<SandboxHandle> {
      assertConnection(connection);
      const template = input.snapshot?.trim() || options.template;
      if (!template) throw new Error("E2B_TEMPLATE_ID is required; build a compatible UseAgent runtime template first");
      const minutes = lifetimeMinutes(input.autoStopInterval);
      const envs = input.envVars ? Object.fromEntries(Object.entries(input.envVars).filter(([key]) => key !== "BASH_ENV")) : undefined;
      const createOptions: SandboxOpts = {
        ...connection, envs, metadata: input.labels,
        secure: true, network: { allowPublicTraffic: false },
        lifecycle: { onTimeout: "pause", autoResume: true },
        timeoutMs: minutes * 60_000,
      };
      const instance = await SdkSandbox.create(template, createOptions);
      try {
        const info = await SdkSandbox.getInfo(instance.sandboxId, connection);
        if (info.sandboxId !== instance.sandboxId) throw new Error("E2B sandbox identity mismatch");
        const handle = new CloudHandle(info, connection, instance, minutes);
        await check(handle);
        return handle;
      } catch (error) {
        await SdkSandbox.kill(instance.sandboxId, connection).catch(() => false);
        throw error;
      }
    },
    async get(id: string): Promise<SandboxHandle> {
      assertConnection(connection);
      let info: SandboxInfo;
      try { info = await SdkSandbox.getInfo(id, connection); }
      catch (error) {
        if (error instanceof SdkSandboxNotFoundError) throw new SandboxNotFoundError(error);
        throw error;
      }
      if (info.sandboxId !== id) throw new Error("E2B sandbox identity mismatch");
      const handle = new CloudHandle(info, connection, null, 30);
      await check(handle);
      return handle;
    },
    async pause(id: string): Promise<void> { assertConnection(connection); await SdkSandbox.pause(id, connection); },
    async *list(): AsyncIterable<SandboxHandle> {
      assertConnection(connection);
      const paginator = SdkSandbox.list(connection);
      while (paginator.hasNext) for (const info of await paginator.nextItems()) yield new CloudHandle(info, connection, null, 30);
    },
  };
}
