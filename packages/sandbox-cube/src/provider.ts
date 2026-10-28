import { createHash } from "node:crypto";
import {
  ConnectionConfig,
  Sandbox as E2BSandbox,
  SandboxNotFoundError as E2BSandboxNotFoundError,
  type SandboxInfo,
  type SandboxOpts,
} from "e2b";
import type {
  SandboxCreateOptions,
  SandboxFileSystem,
  SandboxHandle,
  SandboxInventory,
  SandboxPreviewLink,
  SandboxProcess,
  SandboxProvider,
} from "@useagent/sandbox-contract";
import { SandboxNotFoundError } from "@useagent/sandbox-contract";
import { E2BSdkProcess, E2BSdkFileSystem } from "@useagent/sandbox-e2b-transport";

export const CUBE_SANDBOX_DOMAIN = "cube.app";

export interface CubeProviderOptions {
  /** Shell probe that exits 0 once the runtime identity and workspace are ready; the control plane supplies it. */
  readonly identityPreflightCommand: string;
}

/** Cube preview links authenticate with the traffic token in Cube's own and E2B's header. */
export function cubePreviewAuthHeaders(token: string): Record<string, string> {
  return token
    ? { "cube-traffic-access-token": token, "e2b-traffic-access-token": token }
    : {};
}

interface CubeConnectionOptions {
  apiKey?: string;
  accessToken?: string;
  sandboxUrl?: string;
  apiUrl: string;
  debug: boolean;
  domain: string;
  requestTimeoutMs: number;
  validateApiKey: false;
}

const DEFAULT_READINESS_ATTEMPTS = 20;
const DEFAULT_READINESS_DELAY_MS = 250;

// The provider executes its runtime as root even if the template default differs.
const CUBE_EXEC_USER = "root";

function requireDnsHostname(value: string, envName: string): string {
  if (!/^[a-z0-9.-]+$/i.test(value)) {
    throw new Error(`${envName} must be a DNS hostname`);
  }
  return value;
}

/** The stages of the readiness probe, in the order the sandbox must pass them. */
type CubeReadinessStage = "identity" | "workspace" | "preview_dns" | "public_dns" | "command";

const READINESS_STAGE_LABELS: Record<CubeReadinessStage, string> = {
  identity: "runtime identity (uid, HOME) check",
  workspace: "workspace directory check",
  preview_dns: "DNS lookup of the preview host",
  public_dns: "DNS lookup of the public host",
  command: "command transport (envd over the data plane)",
};

export interface CubeReadinessFailure {
  readonly stage: CubeReadinessStage;
  readonly detail: string;
}

/**
 * The probe prints which stage stopped it so the failure names one thing. The
 * identity command exits non-zero for identity problems and prints
 * "workspace" when only the workspace is missing (see identityPreflightCommand).
 */
export function cubeReadinessProbeCommand(
  identityPreflightCommand: string,
  previewHost: string,
  publicHost: string,
): string {
  return (
    `out=$( { ${identityPreflightCommand}; } 2>&1 ) || { printf 'STAGE=identity %s' "$out" | head -c 400; exit 10; }; ` +
    `test -d "$HOME/work" || mkdir -p "$HOME/work" 2>/dev/null || { printf 'STAGE=workspace HOME=%s' "$HOME"; exit 11; }; ` +
    `getent hosts ${previewHost} >/dev/null 2>&1 || { printf 'STAGE=preview_dns %s' ${JSON.stringify(previewHost)}; exit 12; }; ` +
    `getent hosts ${publicHost} >/dev/null 2>&1 || { printf 'STAGE=public_dns %s' ${JSON.stringify(publicHost)}; exit 13; }; ` +
    `printf READY`
  );
}

/** Turn one probe outcome (an exit code plus output, or a thrown transport error) into the failing stage. */
export function classifyCubeReadinessProbe(
  outcome: { readonly exitCode?: number; readonly result?: string } | { readonly error: unknown },
): CubeReadinessFailure | null {
  if ("error" in outcome) {
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    return { stage: "command", detail: message };
  }
  const text = (outcome.result ?? "").trim();
  if (outcome.exitCode === 0) return null;
  const match = /STAGE=(identity|workspace|preview_dns|public_dns)\s*([\s\S]*)$/.exec(text);
  if (match) {
    return { stage: match[1] as CubeReadinessStage, detail: match[2]?.trim() || `exit ${outcome.exitCode ?? "?"}` };
  }
  return { stage: "command", detail: `exit ${outcome.exitCode ?? "?"}${text ? `: ${text.slice(0, 200)}` : ""}` };
}

export function describeCubeReadinessFailure(sandboxId: string, attempts: number, failure: CubeReadinessFailure): string {
  return (
    `Cube sandbox ${sandboxId} failed readiness after ${attempts} attempts at the ` +
    `${READINESS_STAGE_LABELS[failure.stage]}: ${failure.detail}` +
    (failure.stage === "command"
      ? " (a backend off the Cube host must trust the data plane's private CA via NODE_EXTRA_CA_CERTS)"
      : "")
  );
}

async function waitForCubeReadiness(
  sandbox: SandboxHandle,
  domain: string,
  identityPreflightCommand: string,
): Promise<void> {
  const attempts = positiveInteger(
    process.env.CUBE_READINESS_ATTEMPTS,
    DEFAULT_READINESS_ATTEMPTS,
  );
  const delayMs = positiveInteger(
    process.env.CUBE_READINESS_RETRY_DELAY_MS,
    DEFAULT_READINESS_DELAY_MS,
  );
  const previewHost = `readiness.${requireDnsHostname(domain, "CUBE_SANDBOX_DOMAIN")}`;
  const publicHost = requireDnsHostname(
    process.env.CUBE_READINESS_PUBLIC_HOST?.trim() || "github.com",
    "CUBE_READINESS_PUBLIC_HOST",
  );
  const command = cubeReadinessProbeCommand(identityPreflightCommand, previewHost, publicHost);

  let last: CubeReadinessFailure = { stage: "command", detail: "probe never ran" };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let failure: CubeReadinessFailure | null;
    try {
      failure = classifyCubeReadinessProbe(
        await sandbox.process.executeCommand(command, undefined, undefined, 5),
      );
    } catch (error) {
      // Cube's envd and resolver can become reachable independently; retry both
      // through the next command probe rather than declaring the VM ready.
      failure = classifyCubeReadinessProbe({ error });
    }
    if (!failure) return;
    last = failure;
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  const message = describeCubeReadinessFailure(sandbox.id, attempts, last);
  console.error(`[sandbox-cube] ${message}`);
  throw new Error(message);
}

class CubeRuntimeIdentityMismatchError extends Error {}

async function assertCubeRuntimeIdentity(
  sandbox: SandboxHandle,
  identityPreflightCommand: string,
): Promise<void> {
  const attempts = positiveInteger(process.env.CUBE_IDENTITY_PROBE_ATTEMPTS, 3);
  const delayMs = positiveInteger(process.env.CUBE_IDENTITY_PROBE_DELAY_MS, 100);
  let transientFailure: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const probe = await sandbox.process.executeCommand(
        identityPreflightCommand,
        undefined,
        undefined,
        5,
      );
      if (probe.exitCode === 0) return;
      throw new CubeRuntimeIdentityMismatchError(
        "Cube sandbox did not reach root identity/workspace",
      );
    } catch (error) {
      if (error instanceof CubeRuntimeIdentityMismatchError) throw error;
      transientFailure = error;
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw transientFailure instanceof Error
    ? transientFailure
    : new Error("Cube sandbox identity probe was unavailable");
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function trustedProxyIngress(): boolean {
  const value = process.env.CUBE_PROXY_TRUSTED_INGRESS?.trim().toLowerCase();
  return value === "1" || value === "true";
}

function cubeConnectionOptions(apiKey: string): CubeConnectionOptions {
  const configuredPort = positiveInteger(process.env.CUBE_PROXY_PORT_HTTP, 0);
  const scheme =
    process.env.CUBE_PROXY_SCHEME?.trim().toLowerCase() ||
    (configuredPort === 443 ? "https" : "http");
  if (scheme !== "http" && scheme !== "https") {
    throw new Error("CUBE_PROXY_SCHEME must be http or https");
  }
  const expectedPort = scheme === "https" ? 443 : 80;
  const proxyPort = configuredPort || expectedPort;
  if (proxyPort !== expectedPort) {
    throw new Error(
      `Cube E2B adapter requires the public proxy on ${scheme} port ${expectedPort}; got ${proxyPort}`,
    );
  }
  const options: CubeConnectionOptions = {
    ...(apiKey ? { apiKey } : {}),
    apiUrl: (process.env.CUBE_API_URL?.trim() || "http://127.0.0.1:3000").replace(/\/+$/, ""),
    debug: scheme === "http",
    domain: process.env.CUBE_SANDBOX_DOMAIN?.trim() || CUBE_SANDBOX_DOMAIN,
    requestTimeoutMs: positiveInteger(process.env.CUBE_REQUEST_TIMEOUT_MS, 30_000),
    validateApiKey: false,
  };
  const effective = new ConnectionConfig(options);
  return { ...options, apiKey: effective.apiKey, accessToken: effective.accessToken, sandboxUrl: effective.sandboxUrl };
}

function assertCubeConnectionCurrent(connection: CubeConnectionOptions): void {
  // Missing SDK options can consult ambient state again. Never let a captured
  // anonymous connection silently gain credentials or a different data plane.
  const effective = new ConnectionConfig(connection);
  if (effective.apiKey !== connection.apiKey || effective.accessToken !== connection.accessToken ||
    effective.sandboxUrl !== connection.sandboxUrl) {
    throw new Error("Cube SDK connection changed");
  }
}

function cubeState(state: SandboxInfo["state"]): string {
  return state === "running" ? "started" : state;
}

/** Minutes a sandbox lives from creation or from its last keepAlive; the create option wins over the env default. */
function cubeLifetimeMinutes(autoStopInterval?: number): number {
  return autoStopInterval && autoStopInterval > 0 ? autoStopInterval : positiveInteger(process.env.SANDBOX_AUTO_STOP_MIN, 30);
}

class CubeSandboxHandle implements SandboxHandle {
  readonly providerKind = "cube" as const;
  readonly id: string;
  readonly cpu: number;
  readonly memory: number;
  readonly labels: Record<string, string>;
  readonly process: SandboxProcess;
  readonly fs: SandboxFileSystem;
  state: string;
  private sandbox: E2BSandbox | null;

  constructor(
    info: SandboxInfo,
    private readonly connection: CubeConnectionOptions,
    sandbox: E2BSandbox | null,
    private readonly lifetimeMinutes: number = cubeLifetimeMinutes(),
  ) {
    this.id = info.sandboxId;
    this.cpu = info.cpuCount;
    this.memory = info.memoryMB / 1024;
    this.labels = info.metadata;
    this.state = cubeState(info.state);
    this.sandbox = sandbox;
    const connect = () => this.connected();
    this.process = new E2BSdkProcess(connect, { user: CUBE_EXEC_USER, sessionRoot: "/tmp/skynet-cube-sessions", legacySessionEnv: "SKYNET_SESSION_ID", legacyCommandEnv: "SKYNET_COMMAND_ID" });
    this.fs = new E2BSdkFileSystem(connect, CUBE_EXEC_USER);
  }

  private async connected(): Promise<E2BSandbox> {
    if (!this.sandbox) {
      assertCubeConnectionCurrent(this.connection);
      // Without a timeout a resumed sandbox gets the SDK's 5-minute default and
      // pauses under a follow-up turn before its first keepAlive.
      this.sandbox = await E2BSandbox.connect(this.id, {
        ...this.connection,
        timeoutMs: this.lifetimeMinutes * 60_000,
      });
      this.state = "started";
    }
    return this.sandbox;
  }

  async start(): Promise<void> {
    await this.connected();
  }

  /** The lifetime is absolute from the last time it was set, so a long turn sets it again. */
  async keepAlive(): Promise<void> {
    const sandbox = await this.connected();
    await sandbox.setTimeout(this.lifetimeMinutes * 60_000);
  }

  async delete(): Promise<void> {
    assertCubeConnectionCurrent(this.connection);
    await E2BSandbox.kill(this.id, this.connection);
    this.sandbox = null;
    this.state = "deleted";
  }

  async getPreviewLink(port: number): Promise<SandboxPreviewLink> {
    const sandbox = await this.connected();
    const scheme = this.connection.debug ? "http" : "https";
    return {
      url: `${scheme}://${sandbox.getHost(port)}`,
      token: sandbox.trafficAccessToken,
      headers: cubePreviewAuthHeaders(sandbox.trafficAccessToken ?? ""),
    };
  }
}

class CubeProvider implements SandboxProvider {
  private readonly connection: CubeConnectionOptions;
  readonly connectionFingerprint: string;

  constructor(
    apiKey: string,
    private readonly options: CubeProviderOptions,
  ) {
    this.connection = cubeConnectionOptions(apiKey);
    this.connectionFingerprint = createHash("sha256").update(JSON.stringify([
      "cube", this.connection.apiUrl, this.connection.domain,
      this.connection.debug, this.connection.apiKey ?? "",
      this.connection.accessToken ?? "", this.connection.sandboxUrl ?? "",
    ])).digest("hex");
  }

  async create(options: SandboxCreateOptions = {}): Promise<SandboxHandle> {
    const template = options.snapshot?.trim() || process.env.CUBE_TEMPLATE_ID?.trim();
    if (!template) throw new Error("CUBE_TEMPLATE_ID is required when SANDBOX_PROVIDER=cube");
    const timeoutMinutes = cubeLifetimeMinutes(options.autoStopInterval);
    // Cube rejects shell bootstrap variables such as BASH_ENV at its API
    // boundary. useAgent explicitly sources the protected dotenv when each
    // engine boots, so this compatibility-only variable is unnecessary here.
    // Preserve every runtime/gateway variable the caller supplied.
    const envs = options.envVars
      ? Object.fromEntries(
          Object.entries(options.envVars).filter(([name]) => name !== "BASH_ENV"),
        )
      : undefined;
    const createOptions: SandboxOpts = {
      ...this.connection,
      envs,
      metadata: options.labels,
      // The E2B JS SDK does not attach Cube's per-sandbox traffic token to its
      // envd RPC requests. Keep Cube's token gate on by default; a single-host
      // deployment may instead trust an IP-restricted reverse proxy in front of
      // a firewall-blocked CubeProxy data plane.
      network: { allowPublicTraffic: trustedProxyIngress() },
      lifecycle: { onTimeout: "pause", autoResume: true },
      secure: true,
      timeoutMs: timeoutMinutes * 60_000,
    };
    assertCubeConnectionCurrent(this.connection);
    const sandbox = await E2BSandbox.create(template, createOptions);
    assertCubeConnectionCurrent(this.connection);
    const info = await E2BSandbox.getInfo(sandbox.sandboxId, this.connection);
    const handle = new CubeSandboxHandle(info, this.connection, sandbox, timeoutMinutes);
    try {
      await waitForCubeReadiness(
        handle,
        this.connection.domain,
        this.options.identityPreflightCommand,
      );
      return handle;
    } catch (error) {
      await handle.delete().catch(() => undefined);
      throw error;
    }
  }

  async get(sandboxId: string): Promise<SandboxHandle> {
    assertCubeConnectionCurrent(this.connection);
    let info: SandboxInfo;
    try {
      info = await E2BSandbox.getInfo(sandboxId, this.connection);
    } catch (error) {
      if (error instanceof E2BSandboxNotFoundError) throw new SandboxNotFoundError(error);
      throw error;
    }
    if (info.sandboxId !== sandboxId) throw new Error("Cube sandbox metadata identity mismatch");
    const handle = new CubeSandboxHandle(info, this.connection, null);
    // A retained workspace belongs to the user even when this runtime cannot use it.
    await assertCubeRuntimeIdentity(handle, this.options.identityPreflightCommand);
    return handle;
  }

  /** Pause an idle sandbox without touching it first (a get would resume it); the next connect resumes it. */
  async pause(sandboxId: string): Promise<void> {
    assertCubeConnectionCurrent(this.connection);
    await E2BSandbox.pause(sandboxId, this.connection);
  }

  async *list(): AsyncIterable<SandboxHandle> {
    assertCubeConnectionCurrent(this.connection);
    const paginator = E2BSandbox.list(this.connection);
    while (paginator.hasNext) {
      const items = await paginator.nextItems();
      for (const info of items) yield new CubeSandboxHandle(info, this.connection, null);
    }
  }

  /** Node headroom from CubeOps when configured. No sandbox counts: nothing reads them, and
   *  counting meant listing the whole account on every poll. */
  async inventory(): Promise<SandboxInventory> {
    const token = process.env.CUBE_OPS_ACCESS_TOKEN?.trim();
    if (!token) return {};
    const base = (process.env.CUBE_OPS_URL?.trim() || "http://127.0.0.1:12088/opsapi/v1")
      .replace(/\/+$/, "");
    const response = await fetch(`${base}/nodes`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Cube node inventory failed: HTTP ${response.status}`);
    const raw = await response.json();
    if (!Array.isArray(raw)) throw new Error("Cube node inventory returned a non-array payload");
    const nodes = raw.map((value) => {
      const node = value as Record<string, unknown>;
      const allocatable = node.allocatable as Record<string, unknown> | undefined;
      return {
        id: String(node.nodeID ?? ""),
        ready: node.healthy === true,
        schedulingDisabled: node.schedulingDisabled === true,
        allocatableCpuMillicores: Number(allocatable?.cpuMilli ?? 0),
        allocatableMemoryMib: Number(allocatable?.memoryMB ?? 0),
      };
    }).filter((node) => node.id.length > 0);
    return {
      nodes,
      readyNodes: nodes.filter((node) => node.ready && !node.schedulingDisabled).length,
      allocatableCpuMillicores: nodes.reduce((sum, node) => sum + node.allocatableCpuMillicores, 0),
      allocatableMemoryMib: nodes.reduce((sum, node) => sum + node.allocatableMemoryMib, 0),
    };
  }
}

export function cubeSandboxProvider(
  apiKey: string,
  options: CubeProviderOptions,
): SandboxProvider {
  return new CubeProvider(apiKey, options);
}
