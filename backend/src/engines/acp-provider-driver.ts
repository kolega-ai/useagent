// Provider driver for the native ACP process. Authority remains bound to the
// persisted thread sandbox and the provider's session id.
import type { HarnessRuntime, HarnessSession } from "@useagent/agent-harness/canonical";
import { providerDriverHarnessCapabilities, providerDriverUnsupported, providerProtocolIdentity, providerSessionMatchesDriver, type HarnessAdapter, type ProviderDriver } from "@useagent/agent-harness/control";
import { resolveExpectedSandbox, resolveSandboxBindingForSandbox } from "../sandboxes/binding";
import { parseExpectedSandboxBinding, type ExpectedSandboxBinding } from "../sandboxes/expected-binding";
import type { SandboxHandle } from "../sandboxes/provider";
import { sessionCapabilities } from "./capabilities";
import { acpApprovals } from "./acp-approvals";
import { SandboxAcpSession, type AcpRuntime } from "./acp-sandbox-bridge";
import { ACP_AGENT_VERSION } from "./acp-runtime-config";

export const ACP_SESSION_GENERATION = 1;
const sessions = new Map<string, SandboxAcpSession>();
const error = (code: string, message: string) => ({ status: "error" as const, code, message });

async function resolveSandbox(runtime: HarnessRuntime, metadata?: Record<string, unknown>, threadId?: string): Promise<SandboxHandle> {
  if (runtime.kind !== "sandbox") throw new Error("Kolega Code requires a sandbox");
  const expected = parseExpectedSandboxBinding(metadata?.expectedSandbox);
  if (expected) {
    if (!threadId || runtime.id !== expected.sandboxId) throw new Error("Sandbox binding does not match the session");
    return await resolveExpectedSandbox(expected, threadId);
  }
  return await (await resolveSandboxBindingForSandbox(runtime.id)).provider.get(runtime.id);
}

export function sameAcpBinding(left: ExpectedSandboxBinding | undefined, right: ExpectedSandboxBinding): boolean {
  return Boolean(left && left.version === right.version && left.sandboxId === right.sandboxId &&
    left.provider === right.provider && left.credential === right.credential &&
    left.ownerOrgId === right.ownerOrgId && left.ownerUserId === right.ownerUserId &&
    left.credentialGeneration === right.credentialGeneration);
}

async function checkedSession(session: HarnessSession, metadata?: Record<string, unknown>, threadId?: string): Promise<SandboxAcpSession> {
  const live = sessions.get(session.nativeSessionId);
  if (!live || session.runtime.kind !== "sandbox" || live.sandboxId !== session.runtime.id) throw new Error("Kolega Code session is not live");
  const expected = parseExpectedSandboxBinding(metadata?.expectedSandbox);
  if (expected) {
    if (!sameAcpBinding(live.expectedSandbox, expected)) throw new Error("Sandbox binding does not match the session");
    await resolveSandbox(session.runtime, metadata, threadId);
  }
  return live;
}

function prepared(metadata: Record<string, unknown> | undefined): { workdir: string; runtime: AcpRuntime } {
  const workdir = metadata?.workdir;
  const runtime = metadata?.runtime as AcpRuntime | undefined;
  if (typeof workdir !== "string" || !workdir.startsWith("/") || !runtime ||
    typeof runtime.executable !== "string" || !runtime.executable.startsWith("/") ||
    typeof runtime.home !== "string" || !runtime.home.startsWith("/") ||
    typeof runtime.spoolDirectory !== "string" || !runtime.spoolDirectory.startsWith("/") ||
    typeof runtime.model !== "string" || !["openai_responses", "openai_chat", "anthropic"].includes(runtime.style) ||
    (runtime.mode !== "plan" && runtime.mode !== "build") ||
    (runtime.permission !== "ask" && runtime.permission !== "auto") ||
    (runtime.runAsUser !== null && typeof runtime.runAsUser !== "string")) {
    throw new Error("Kolega Code runtime metadata is incomplete");
  }
  return { workdir, runtime };
}

function canonical(runtime: HarnessRuntime, bridge: SandboxAcpSession): HarnessSession {
  return { provider: "kolega", nativeSessionId: bridge.sessionFile, runtime,
    protocolVersion: providerProtocolIdentity(acpProviderDriver.descriptor.protocol),
    capabilities: acpProviderDriver.descriptor.capabilities, generation: ACP_SESSION_GENERATION };
}

export function getAcpSession(id: string): SandboxAcpSession | undefined { return sessions.get(id); }
export async function closeAcpSession(id: string): Promise<void> {
  const bridge = sessions.get(id);
  if (!bridge) return;
  acpApprovals.cancelSession(id);
  await bridge.dispose();
  if (sessions.get(id) === bridge) sessions.delete(id);
}
export async function closeAcpSandboxSessions(sandboxId: string): Promise<void> {
  for (const [id, session] of sessions) {
    if (session.sandboxId === sandboxId) await closeAcpSession(id);
  }
}

const capabilities = sessionCapabilities("kolega", { desktop: false, knowledgeTools: false });
export const acpProviderDriver: ProviderDriver = {
  provider: "kolega",
  descriptor: {
    provider: "kolega", protocol: { name: "acp", version: ACP_AGENT_VERSION },
    sessionGeneration: ACP_SESSION_GENERATION, capabilities,
    lifecycle: { operations: ["start", "resume", "steer", "cancel"], steerInputs: ["prompt"] },
    model: { selection: "per_turn", supportsArbitraryModel: false },
    tools: { mode: "provider_native", approval: "useagent" },
  },
  async start(request) {
    try {
      const { workdir, runtime } = prepared(request.metadata);
      const sandbox = await resolveSandbox(request.runtime, request.metadata, request.threadId);
      const expectedSandbox = parseExpectedSandboxBinding(request.metadata?.expectedSandbox) ?? undefined;
      const bridge = await SandboxAcpSession.open({ sandbox, workdir, runtime, expectedSandbox });
      if (sessions.has(bridge.sessionFile)) { await bridge.dispose(); return error("session_conflict", "Kolega Code session id is already in use"); }
      sessions.set(bridge.sessionFile, bridge);
      return { status: "ok", value: canonical(request.runtime, bridge) };
    } catch { return error("session_create_failed", "Kolega Code could not create a sandbox session"); }
  },
  async resume(request) {
    if (!providerSessionMatchesDriver(acpProviderDriver, request.session)) return error("stale_session", "Kolega Code session authority is stale");
    try {
      const { workdir, runtime } = prepared(request.metadata);
      const threadId = typeof request.metadata?.threadId === "string" ? request.metadata.threadId : undefined;
      const sandbox = await resolveSandbox(request.session.runtime, request.metadata, threadId);
      const expectedSandbox = parseExpectedSandboxBinding(request.metadata?.expectedSandbox) ?? undefined;
      const bridge = await SandboxAcpSession.open({ sandbox, workdir, runtime, expectedSandbox, resumeId: request.session.nativeSessionId });
      if (sessions.has(bridge.sessionFile)) { await bridge.dispose(); return error("session_conflict", "Kolega Code session id is already in use"); }
      sessions.set(bridge.sessionFile, bridge);
      return { status: "ok", value: canonical(request.session.runtime, bridge) };
    } catch { return error("session_resume_failed", "Kolega Code could not restore its session in the retained sandbox"); }
  },
  async steer(request) {
    if (!providerSessionMatchesDriver(acpProviderDriver, request.session)) return error("stale_session", "Kolega Code session authority is stale");
    if (request.input.kind !== "prompt") return { status: "unsupported_capability", provider: "kolega", capability: request.input.kind };
    try {
      const bridge = await checkedSession(request.session, request.metadata, request.threadId);
      await bridge.prompt(request.input.text);
      return { status: "ok" };
    } catch { return error("steer_failed", "Kolega Code could not accept the prompt"); }
  },
  async cancel(session, _reason, metadata) {
    if (!providerSessionMatchesDriver(acpProviderDriver, session)) return error("stale_session", "Kolega Code session authority is stale");
    try {
      const threadId = typeof metadata?.threadId === "string" ? metadata.threadId : undefined;
      const bridge = await checkedSession(session, metadata, threadId);
      acpApprovals.cancelSession(session.nativeSessionId);
      await bridge.cancel();
      return { status: "ok" };
    } catch { return error("cancel_failed", "Kolega Code could not cancel the active session"); }
  },
};

export const acpHarness: HarnessAdapter = {
  provider: "kolega",
  capabilities: () => providerDriverHarnessCapabilities(acpProviderDriver),
  cancel(handle, reason, metadata) {
    return acpProviderDriver.cancel({ provider: "kolega", nativeSessionId: handle.sessionId,
      runtime: { kind: "sandbox", id: handle.sandboxId },
      protocolVersion: handle.protocol ?? providerProtocolIdentity(acpProviderDriver.descriptor.protocol),
      capabilities, generation: handle.generation ?? ACP_SESSION_GENERATION }, reason, metadata);
  },
  reconcile() { return Promise.resolve(providerDriverUnsupported("kolega", "reconcile", "An interrupted in-flight ACP turn cannot be reconstructed")); },
};
